import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { citableChunks, verifyWorkItemClaims } from './claims.js';
import { init, openWorkspaceDatabase } from './commands.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * P1-GATE-04 end to end, against a real workspace and a real PGlite.
 *
 * The unit tests cover which outcome each input reaches. What is checked here is
 * that the daemon's verdict actually lands as gating evidence — a claim gate
 * whose result never reaches the database would be the same kind of decorative
 * capability the blind evaluations keep finding.
 */

const run = promisify(execFile);
let root: string;
let cardPath: string;

const CARD = [
  '---',
  '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
  'id: FEAT-001',
  'kind: feature',
  'title: CSV import',
  'status: In Progress',
  'lifecycle_state: implement',
  'work_type: feature',
  'preset: standard',
  'risk_level: low',
  'verify: node test.js',
  'done:',
  '  - tests pass',
  'created_at: 2026-08-10T00:00:00.000Z',
  'updated_at: 2026-08-10T00:00:00.000Z',
  '---',
  '',
  'See the [import spec](../../docs/spec.md).',
  '',
].join('\n');

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-claims-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });

  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'docs', 'spec.md'),
    '# Import spec\n\nThe importer retries three times with exponential backoff.\n\n' +
      '## Non-goals\n\nMulti-currency handling is out of scope for this release.\n',
    'utf8',
  );

  cardPath = path.join(root, 'kanban', '_inbox', 'FEAT-001.md');
  await fs.writeFile(cardPath, CARD, 'utf8');
}, 60_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('citableChunks', () => {
  it('includes the card and the documents it links', async () => {
    const chunks = await citableChunks(root, cardPath);
    expect(chunks.some((chunk) => chunk.id.startsWith('docs/spec.md#'))).toBe(true);
    expect(chunks.some((chunk) => chunk.id.startsWith('kanban/'))).toBe(true);
  });

  it('gives every chunk an id of the shape the retriever already emits', async () => {
    const chunks = await citableChunks(root, cardPath);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) expect(chunk.id).toMatch(/^[^#]+#\d+$/);
  });

  it('does not follow a link out of the workspace', async () => {
    const outside = path.join(path.dirname(root), 'elsewhere.md');
    await fs.writeFile(outside, '# elsewhere\n\nsecrets\n', 'utf8');
    await fs.writeFile(cardPath, `${CARD}\n[escape](../../../elsewhere.md)\n`, 'utf8');

    // A card is authored content; its links are data, not instructions about
    // which host files to read.
    const chunks = await citableChunks(root, cardPath);
    expect(chunks.some((chunk) => chunk.id.includes('elsewhere'))).toBe(false);

    await fs.writeFile(cardPath, CARD, 'utf8');
    await fs.rm(outside, { force: true });
  });
});

describe('verifyWorkItemClaims', () => {
  it('records a daemon-produced verdict that can gate', async () => {
    const chunks = await citableChunks(root, cardPath);
    const specChunk = chunks.find((chunk) => chunk.text.includes('retries three times'));
    expect(specChunk).toBeDefined();

    const result = await verifyWorkItemClaims(root, 'FEAT-001', [
      {
        claim: 'The importer retries three times with exponential backoff',
        cited_chunk_ids: [specChunk?.id ?? ''],
      },
    ]);

    expect(result.bundle.ok).toBe(true);
    expect(result.gateResult).toBe('pass');
    expect(result.evidenceId).toBeGreaterThan(0);
  }, 60_000);

  it('fails the gate on a fabricated citation and takes the flag-for-review route', async () => {
    const result = await verifyWorkItemClaims(root, 'FEAT-001', [
      { claim: 'Every acceptance criterion is satisfied.', cited_chunk_ids: ['docs/spec.md#999'] },
    ]);

    expect(result.gateResult).toBe('fail');
    expect(result.bundle.unsupported).toHaveLength(1);
    expect(result.bundle.abstained).toHaveLength(0);
  }, 60_000);

  it('abstains rather than passing when nothing could verify the claim', async () => {
    const result = await verifyWorkItemClaims(root, 'FEAT-001', [
      { claim: 'The design is consistent with ADR-0009.', cited_chunk_ids: [] },
    ]);

    // Not a pass. "Nothing checked this" must never look like "this is fine".
    expect(result.bundle.ok).toBe(false);
    expect(result.gateResult).toBe('fail');
    expect(result.bundle.abstained).toHaveLength(1);
    expect(result.bundle.unsupported).toHaveLength(0);
  }, 60_000);
});

describe('the traceability graph (P1-GATE-08, ADR-0032)', () => {
  it('records an edge for a supported claim and none for one that abstained', async () => {
    const chunks = await citableChunks(root, cardPath);
    const specChunk = chunks.find((chunk) => chunk.text.includes('retries three times'));

    await verifyWorkItemClaims(root, 'FEAT-001', [
      {
        claim: 'The importer retries three times with exponential backoff',
        cited_chunk_ids: [specChunk?.id ?? ''],
      },
      { claim: 'The design is consistent with ADR-0009.', cited_chunk_ids: [] },
    ]);

    const { db } = await openWorkspaceDatabase(root);
    try {
      const rows = await db.query<{ ac_id: string; file_path: string; origin: string }>(
        "SELECT ac_id, file_path, origin FROM traceability_edges WHERE origin = 'claim-verification';",
      );
      // Only the supported claim. Recording the abstention would let coverage
      // be raised by asserting things nobody verified.
      expect(rows.some((row) => row.ac_id.includes('retries three times'))).toBe(true);
      expect(rows.some((row) => row.ac_id.includes('ADR-0009'))).toBe(false);
      expect(rows.every((row) => row.file_path === 'docs/spec.md')).toBe(true);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('does not multiply the graph when the same verification runs twice', async () => {
    const chunks = await citableChunks(root, cardPath);
    const specChunk = chunks.find((chunk) => chunk.text.includes('retries three times'));
    const claims = [
      {
        claim: 'The importer retries three times with exponential backoff',
        cited_chunk_ids: [specChunk?.id ?? ''],
      },
    ];

    await verifyWorkItemClaims(root, 'FEAT-001', claims);
    const before = await countEdges();
    await verifyWorkItemClaims(root, 'FEAT-001', claims);
    const after = await countEdges();

    // A re-run records the same fact, and the same fact recorded twice is one
    // fact. Without the uniqueness index, coverage climbs every time a suite
    // is re-run.
    // Exactly equal, not "at most one more": a weaker assertion here passes
    // with the uniqueness index removed, which is the whole thing under test.
    expect(after).toBe(before);
  }, 60_000);
});

async function countEdges(): Promise<number> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM traceability_edges WHERE origin = 'claim-verification';",
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await db.close();
  }
}

describe('coverage means current proof (ADR-0032)', () => {
  it('replaces the evidence on a link rather than accumulating rows', async () => {
    const chunks = await citableChunks(root, cardPath);
    const specChunk = chunks.find((chunk) => chunk.text.includes('retries three times'));
    const claims = [
      {
        claim: 'The importer retries three times with exponential backoff',
        cited_chunk_ids: [specChunk?.id ?? ''],
      },
    ];

    await verifyWorkItemClaims(root, 'FEAT-001', claims);
    const second = await verifyWorkItemClaims(root, 'FEAT-001', claims);

    const { db } = await openWorkspaceDatabase(root);
    try {
      const rows = await db.query<{ evidence_id: string | number }>(
        `SELECT evidence_id FROM traceability_edges
          WHERE origin = 'claim-verification' AND ac_id LIKE '%retries three times%';`,
      );
      expect(rows).toHaveLength(1);
      // The link is the fact; the evidence is the *current* proof of it.
      // "Covered" has to mean covered by current tests against the current
      // implementation, not covered once by something.
      expect(Number(rows[0]?.evidence_id)).toBe(second.evidenceId);
    } finally {
      await db.close();
    }
  }, 60_000);
});

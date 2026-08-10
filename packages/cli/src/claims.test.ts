import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { citableChunks, verifyWorkItemClaims } from './claims.js';
import { init } from './commands.js';

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
  await init(root);

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
  await fs.rm(root, { recursive: true, force: true });
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

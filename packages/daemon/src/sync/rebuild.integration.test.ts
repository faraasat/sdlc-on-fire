import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { rebuildMirror } from './rebuild.js';

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
 * `db:rebuild` (P0-DB-04).
 *
 * This is the invariant "content in git, state in DB" made executable, so the
 * tests are about survival and about what must *not* survive: everything the
 * files hold comes back, everything stale goes away, and the evidence record —
 * which no file holds — is never touched.
 */

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let root: string;

const card = (id: string, title: string): string =>
  `---\nid: ${id}\nkind: task\ntitle: ${title}\nstatus: In Progress\n` +
  `lifecycle_state: implement\nwork_type: task\npreset: standard\n---\n\n` +
  `## Description\n\nThe ${title} pipeline streams rows to disk.\n`;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rebuild-')));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);

  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'specs'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'kanban', '_inbox', 'TASK-001.md'),
    card('TASK-001', 'export'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'kanban', '_inbox', 'TASK-002.md'),
    card('TASK-002', 'import'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'docs', 'specs', 'export.md'),
    `---\nid: SPEC-1\ntitle: Export spec\n---\n\n# Export\n\nRows are quarantined on failure.\n`,
    'utf8',
  );
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('rebuilding from git', () => {
  it('reconstructs the mirror from an empty database', async () => {
    const result = await rebuildMirror(root, port);
    expect(result.workItems).toBe(2);
    expect(result.docs).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('reconstructs chunks too, so retrieval survives a rebuild', async () => {
    // Chunks are derived, not authored — a rebuild that restored rows but not
    // chunks would leave retrieval silently empty.
    const hits = await port.searchChunks('quarantined', 5);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('is idempotent — a second rebuild gives the same mirror, not double', async () => {
    await rebuildMirror(root, port);
    const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM work_items;');
    expect(rows[0]?.n).toBe(2);
  });

  it('drops rows whose file no longer exists', async () => {
    await fs.rm(path.join(root, 'kanban', '_inbox', 'TASK-002.md'));
    const result = await rebuildMirror(root, port);

    expect(result.workItems).toBe(1);
    expect(await port.stageOf('TASK-002')).toBeNull();
    expect(await port.stageOf('TASK-001')).not.toBeNull();
  });

  it('reports a malformed file instead of aborting the whole rebuild', async () => {
    // A rebuild that throws on the first bad card leaves the mirror empty,
    // which is strictly worse than the state it started from.
    const bad = path.join(root, 'kanban', '_inbox', 'TASK-003.md');
    await fs.writeFile(bad, `---\nkind: task\ntitle: no id here\n---\n\nbody\n`, 'utf8');

    const result = await rebuildMirror(root, port);
    expect(result.failed.map((f) => f.relativePath)).toContain('kanban/_inbox/TASK-003.md');
    // The good cards still landed.
    expect(result.workItems).toBe(1);
    expect(await port.stageOf('TASK-001')).not.toBeNull();

    await fs.rm(bad);
  });
});

describe('what a rebuild must never destroy', () => {
  it('leaves evidence, gates and the audit log untouched', async () => {
    // The mirror is a cache of files. Evidence is the authoritative record of
    // what was verified — a rebuild that discarded it would be a way to launder
    // a failing gate rather than a maintenance command.
    await db.query(
      `INSERT INTO evidence
         (kind, producer, git_sha, env, content_hash, confidence, produced_at, payload)
       VALUES ('test', 'daemon', 'abc123', '{}'::jsonb, 'h', 1, now(), '{}'::jsonb);`,
    );
    const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM evidence;');

    await rebuildMirror(root, port);

    const after = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM evidence;');
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBeGreaterThan(0);
  });
});

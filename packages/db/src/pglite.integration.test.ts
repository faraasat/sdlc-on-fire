import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DatabaseLockedError,
  MINIMUM_SERVER_VERSION_MAJOR,
  provisionPglite,
  type ProvisionedDatabase,
} from './pglite.js';

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
 * These tests boot a real PGlite instance rather than mocking one. A mocked
 * provisioner would prove only that the mock behaves like the mock — the whole
 * point of this adapter is that pgvector genuinely loads and the data directory
 * is genuinely exclusive.
 */

const opened: ProvisionedDatabase[] = [];
const tempRoots: string[] = [];

async function freshWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-db-'));
  tempRoots.push(root);
  return root;
}

async function open(workspaceRoot: string): Promise<ProvisionedDatabase> {
  const db = await provisionPglite({ workspaceRoot });
  opened.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.close().catch(() => undefined)));
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('provisioning', () => {
  it('creates the data directory under .sdlcof/db', async () => {
    const root = await freshWorkspace();
    const db = await open(root);

    expect(db.dataDir).toBe(path.join(root, '.sdlcof', 'db'));
    await expect(fs.stat(db.dataDir)).resolves.toBeDefined();
  }, 60_000);

  it('reports a server version at or above the schema minimum', async () => {
    const db = await open(await freshWorkspace());
    expect(db.capabilities.serverVersionMajor).toBeGreaterThanOrEqual(MINIMUM_SERVER_VERSION_MAJOR);
  }, 60_000);

  it('actually loads pgvector rather than assuming it', async () => {
    const db = await open(await freshWorkspace());
    expect(db.capabilities.vector).toBe(true);
    expect(db.capabilities.vectorVersion).not.toBeNull();
  }, 60_000);

  it('exposes the HNSW access method the schema indexes with', async () => {
    const db = await open(await freshWorkspace());
    expect(db.capabilities.hnsw).toBe(true);
  }, 60_000);
});

describe('pgvector really works, not merely installs', () => {
  it('builds an HNSW index and answers a cosine KNN query', async () => {
    const db = await open(await freshWorkspace());

    await db.exec(`
      CREATE TABLE chunks (id int PRIMARY KEY, embedding vector(3));
      INSERT INTO chunks VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]');
      CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 96);
    `);

    const rows = await db.query<{ id: number }>(
      "SELECT id FROM chunks ORDER BY embedding <=> '[1,0,0]' LIMIT 2;",
    );

    // Nearest to [1,0,0] is itself, then the near-parallel vector — not the orthogonal one.
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  }, 60_000);
});

describe('single-owner enforcement (risk R-02)', () => {
  it('refuses a second owner of the same data directory', async () => {
    const root = await freshWorkspace();
    await open(root);

    // PGlite is single-connection; a second opener would risk WAL corruption.
    await expect(provisionPglite({ workspaceRoot: root })).rejects.toBeInstanceOf(
      DatabaseLockedError,
    );
  }, 60_000);

  it('releases ownership on close so the directory can be reopened', async () => {
    const root = await freshWorkspace();
    const first = await open(root);
    await first.close();

    const second = await open(root);
    expect(second.capabilities.vector).toBe(true);
  }, 60_000);

  it('leaves separate workspaces independent', async () => {
    const a = await open(await freshWorkspace());
    const b = await open(await freshWorkspace());
    expect(a.dataDir).not.toBe(b.dataDir);
  }, 60_000);
});

describe('persistence', () => {
  it('survives a close and reopen of the same data directory', async () => {
    const root = await freshWorkspace();
    const first = await open(root);
    await first.exec(
      'CREATE TABLE persisted (id int PRIMARY KEY); INSERT INTO persisted VALUES (7);',
    );
    await first.close();

    const second = await open(root);
    const rows = await second.query<{ id: number }>('SELECT id FROM persisted;');
    expect(rows).toEqual([{ id: 7 }]);
  }, 60_000);
});

describe('close', () => {
  it('is idempotent', async () => {
    const db = await open(await freshWorkspace());
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  }, 60_000);
});

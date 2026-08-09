import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIFECYCLE_STAGES } from '@sdlc-on-fire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, migrationFiles, seedLifecycleStates } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';

/**
 * Applies the real generated migration to a real PGlite. A mocked runner would
 * only prove the SQL string was passed along, not that Postgres accepts it —
 * and "the schema actually creates" is the entire claim being made here.
 */

const opened: ProvisionedDatabase[] = [];
const tempRoots: string[] = [];
let db: ProvisionedDatabase;

async function freshDb(): Promise<ProvisionedDatabase> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-migrate-'));
  tempRoots.push(root);
  const handle = await provisionPglite({ workspaceRoot: root });
  opened.push(handle);
  return handle;
}

beforeAll(async () => {
  db = await freshDb();
  await applySchema(db);
}, 90_000);

async function tableNames(handle: ProvisionedDatabase): Promise<string[]> {
  const rows = await handle.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;",
  );
  return rows.map((row) => row.table_name);
}

describe('generated migration', () => {
  it('exists and is the only source of table shape', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.endsWith('.sql'))).toBe(true);
  });

  it('creates every MVP table', async () => {
    const tables = await tableNames(db);
    for (const table of [
      'lifecycle_states',
      'lifecycle_transitions',
      'actors',
      'roles',
      'work_items',
      'docs',
      'gate_policies',
      'gates',
      'approvals',
      'evidence',
      'gate_evidence',
      'runs',
      'embeddings',
      'audit_log',
    ]) {
      expect(tables, table).toContain(table);
    }
  });

  it('does not create tables deferred past v0.1', async () => {
    // Building ahead of the slice is as much a defect as building short of it.
    const tables = await tableNames(db);
    for (const table of ['traceability_edges', 'memory_entries', 'checkpoints', 'external_ref']) {
      expect(tables, table).not.toContain(table);
    }
  });
});

describe('pgvector wiring', () => {
  it('creates the HNSW index the retrieval path needs', async () => {
    const rows = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'embeddings';",
    );
    expect(rows.map((r) => r.indexname)).toContain('embeddings_hnsw_idx');
  });

  it('gives embeddings a real vector column', async () => {
    const rows = await db.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'embeddings' AND column_name = 'embedding';",
    );
    expect(rows[0]?.udt_name).toBe('vector');
  });

  it('accepts a 384-dimension vector and rejects the wrong width', async () => {
    const vec = `[${Array.from({ length: 384 }, () => 0).join(',')}]`;
    await db.query(
      `INSERT INTO embeddings (source_table, source_id, chunk_index, chunk_text, content_hash, model, embedding)
       VALUES ('docs', 'd1', 0, 'x', 'h', 'bge-small-en-v1.5', $1);`,
      [vec],
    );
    await expect(
      db.query(
        `INSERT INTO embeddings (source_table, source_id, chunk_index, chunk_text, content_hash, model, embedding)
         VALUES ('docs', 'd2', 0, 'x', 'h', 'm', '[1,2,3]');`,
      ),
    ).rejects.toThrow();
  });
});

describe('lifecycle seed', () => {
  it('seeds every stage in the canonical vocabulary', async () => {
    const rows = await db.query<{ key: string }>('SELECT key FROM lifecycle_states ORDER BY key;');
    expect(rows.map((r) => r.key).sort()).toEqual([...LIFECYCLE_STAGES].sort());
  });

  it('marks done, and only done, terminal', async () => {
    const rows = await db.query<{ key: string }>(
      'SELECT key FROM lifecycle_states WHERE is_terminal = true;',
    );
    expect(rows.map((r) => r.key)).toEqual(['done']);
  });

  it('is idempotent', async () => {
    await seedLifecycleStates(db);
    const rows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM lifecycle_states;',
    );
    expect(rows[0]?.count).toBe(LIFECYCLE_STAGES.length);
  });
});

describe('constraints actually enforce', () => {
  it('rejects a work item with an unknown type', async () => {
    await expect(
      db.query(
        `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
         VALUES ('X-1', 'card', 't', 'Backlog', 'implement', 'kanban/x1.md', 'h');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a work item referencing a non-existent stage', async () => {
    await expect(
      db.query(
        `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
         VALUES ('TASK-900', 'task', 't', 'Backlog', 'not-a-stage', 'kanban/t900.md', 'h');`,
      ),
    ).rejects.toThrow();
  });

  it('rejects two work items claiming the same file', async () => {
    // One file, one work item — otherwise the mirror can disagree with git.
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('TASK-901', 'task', 't', 'In Progress', 'implement', 'kanban/dup.md', 'h');`,
    );
    await expect(
      db.query(
        `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
         VALUES ('TASK-902', 'task', 't', 'In Progress', 'implement', 'kanban/dup.md', 'h');`,
      ),
    ).rejects.toThrow();
  });

  it('bounds evidence confidence to 0..1', async () => {
    await expect(
      db.query(
        `INSERT INTO evidence (kind, producer, git_sha, env, content_hash, confidence, produced_at, payload)
         VALUES ('test', 'daemon', 'a', '{}'::jsonb, 'h', 1.5, now(), '{}'::jsonb);`,
      ),
    ).rejects.toThrow();
  });

  it('rejects an unknown evidence producer', async () => {
    await expect(
      db.query(
        `INSERT INTO evidence (kind, producer, git_sha, env, content_hash, confidence, produced_at, payload)
         VALUES ('test', 'vibes', 'a', '{}'::jsonb, 'h', 1.0, now(), '{}'::jsonb);`,
      ),
    ).rejects.toThrow();
  });

  it('requires a reason on an override approval', async () => {
    const actor = await db.query<{ id: string }>(
      "INSERT INTO actors (kind, display_name) VALUES ('human', 'Tester') RETURNING id;",
    );
    const actorId = actor[0]?.id;
    await expect(
      db.query(`INSERT INTO approvals (gate_id, actor_id, decision) VALUES (1, $1, 'override');`, [
        actorId,
      ]),
    ).rejects.toThrow();
  });
});

describe('idempotency', () => {
  it('re-applying the schema is a no-op, not a hazard', async () => {
    // `db:up` on an existing workspace must be safe.
    await expect(applySchema(db)).resolves.toBeUndefined();
  });
});

afterAll(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close().catch(() => undefined)));
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

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
    //
    // `memory_entries` left this list on 2026-08-10 by an explicit founder scope
    // decision: the standing instruction is to complete Phase 1 in full, and
    // P1-OBJ-04 is a Phase-1 task. The guard is loosened deliberately and the
    // reason is recorded here rather than in a commit message nobody re-reads —
    // a guard quietly edited to make new code pass is worse than no guard.
    //
    // The remaining three are still genuinely unbuilt.
    const tables = await tableNames(db);
    for (const table of ['traceability_edges', 'checkpoints', 'external_ref']) {
      expect(tables, table).not.toContain(table);
    }
  });

  it('creates memory_entries with its bi-temporal columns (P1-OBJ-04)', async () => {
    // The inverse of the guard above: a table admitted into the slice has to
    // actually arrive, with the columns the contract specifies. §3.7's whole
    // point is the two time axes plus the supersession link.
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'memory_entries';",
    );
    const names = columns.map((row) => row.column_name);
    for (const column of [
      'valid_from',
      'valid_to',
      'superseded_by',
      'conflict_status',
      'source_type',
      'written_by',
    ]) {
      expect(names, column).toContain(column);
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

describe('invariant triggers', () => {
  it('refuses a role-gated approval from an agent', async () => {
    // The trigger IS the disposer: it fires regardless of what daemon code does,
    // so a bug in the application layer cannot defeat the invariant.
    const [role] = await db.query<{ id: number }>(
      "INSERT INTO roles (key) VALUES ('maintainer') RETURNING id;",
    );
    const [agent] = await db.query<{ id: string }>(
      "INSERT INTO actors (kind, display_name, agent_target) VALUES ('agent','Claude','claude-code') RETURNING id;",
    );

    await expect(
      db.query(
        "INSERT INTO approvals (gate_id, actor_id, role_id, decision) VALUES (1, $1, $2, 'approve');",
        [agent?.id, role?.id],
      ),
    ).rejects.toThrow(/agent/);
  });

  it('allows a human role-gated approval', async () => {
    const [role] = await db.query<{ id: number }>(
      "INSERT INTO roles (key) VALUES ('reviewer') RETURNING id;",
    );
    const [human] = await db.query<{ id: string }>(
      "INSERT INTO actors (kind, display_name) VALUES ('human','Dev') RETURNING id;",
    );

    await expect(
      db.query(
        "INSERT INTO approvals (gate_id, actor_id, role_id, decision) VALUES (2, $1, $2, 'approve');",
        [human?.id, role?.id],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to link agent-claim evidence to an ordinary gate', async () => {
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('TASK-800','task','t','In Progress','implement','kanban/t800.md','h');`,
    );
    const [gate] = await db.query<{ id: number }>(
      "INSERT INTO gates (work_item_id, gate_name, result) VALUES ('TASK-800','implement','pending') RETURNING id;",
    );
    const [ev] = await db.query<{ id: number }>(
      `INSERT INTO evidence (kind, producer, git_sha, env, content_hash, confidence, produced_at, payload)
       VALUES ('test','agent-claim','a','{}'::jsonb,'h',0,now(),'{"ok":true}'::jsonb) RETURNING id;`,
    );

    await expect(
      db.query('INSERT INTO gate_evidence (gate_id, evidence_id) VALUES ($1, $2);', [
        gate?.id,
        ev?.id,
      ]),
    ).rejects.toThrow(/agent-claim/);
  });
});

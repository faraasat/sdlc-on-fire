import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTerminalStage, LIFECYCLE_STAGES } from '@sdlc-on-fire/core';

/**
 * Schema application for the PGlite fast path.
 *
 * The generated migration in `migrations/` is the single source of truth for
 * table shape — it comes from `src/schema.ts` via drizzle-kit and is never
 * hand-edited. What lives here instead is the DDL Drizzle's schema builder
 * cannot express, plus the seed data the state machine needs to exist before
 * any work item can reference a stage.
 */

/** Minimal surface this module needs — avoids coupling to the PGlite handle type. */
export interface SqlRunner {
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

/** Generated migration files, in lexical (= chronological) order. */
export async function migrationFiles(): Promise<string[]> {
  const dir = migrationsDir();
  const entries = await fs.readdir(dir);
  return entries
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => path.join(dir, entry));
}

/**
 * DDL the Drizzle schema builder cannot express.
 *
 * Kept as explicit statements rather than folded into the generated migration,
 * because drizzle-kit would drop them on the next `generate` — a silently
 * disappearing `REVOKE` is exactly the failure the audit chain cannot survive.
 */
export const SUPPLEMENTAL_DDL: readonly string[] = [
  // Postgres-compatible subset only: no extension beyond pgvector (ADR-0003/0006).
  'CREATE EXTENSION IF NOT EXISTS vector;',

  // Vector column + HNSW index. Drizzle emits the column, but the index's
  // operator class and build parameters are pgvector-specific.
  `CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings
     USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 96);`,
  'CREATE INDEX IF NOT EXISTS embeddings_source_idx ON embeddings (source_table, source_id);',

  // ── Full-text search for the v0.1 tsvector-only retrieval path (mvp-slice) ──
  //
  // The searchable vector is a STORED generated column, not an expression index.
  // P0-SPIKE-02 measured the difference on 50k rows: ranking with `ts_rank_cd`
  // over an expression index re-derives the tsvector for every candidate row and
  // costs 1,566ms; ranking on the stored column costs 68ms for the identical
  // result set. The column is materialised once per write instead of once per
  // read, which is the right trade for a corpus read far more than written.
  // Contract 01 §3.2/§3.3/§3.6 were amended to this shape first.
  //
  // Drizzle does not model generated columns, so both the column and its index
  // live here rather than in schema.ts.
  `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS title_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', title)) STORED;`,
  'CREATE INDEX IF NOT EXISTS work_items_title_tsv_idx ON work_items USING GIN (title_tsv);',
  `ALTER TABLE docs ADD COLUMN IF NOT EXISTS title_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;`,
  'CREATE INDEX IF NOT EXISTS docs_title_tsv_idx ON docs USING GIN (title_tsv);',

  // The chunk index contract §3.6 has always named, and which nothing created
  // until P0-SPIKE-02 went looking. `embeddings.chunk_text` is *the* searchable
  // body text (§4) — without this, content retrieval is a sequential scan.
  `ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_tsv tsvector
     GENERATED ALWAYS AS (to_tsvector('english', chunk_text)) STORED;`,
  'CREATE INDEX IF NOT EXISTS embeddings_chunk_tsv_idx ON embeddings USING GIN (chunk_tsv);',

  // Append-only audit log (ADR-0030). Never relaxed, not even for MVP —
  // architecture §5 lists it among the never-relaxed invariants.
  'REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;',

  // ── The two invariant triggers (contracts/01 §3.3, §3.4) ──────────────────
  //
  // These ARE the deterministic disposers for two architecture §5 invariants,
  // and they exist precisely because application-layer checks are not enough:
  // a trigger fires regardless of what the daemon's own code does, so a bug in
  // the daemon cannot let an agent approve its own work or gate on its own
  // say-so. CHECK constraints cannot subquery, hence triggers.
  `CREATE OR REPLACE FUNCTION approvals_agent_never_approves() RETURNS trigger AS $$
     DECLARE actor_kind TEXT;
     BEGIN
       SELECT kind INTO actor_kind FROM actors WHERE id = NEW.actor_id;
       IF actor_kind = 'agent' AND NEW.role_id IS NOT NULL THEN
         RAISE EXCEPTION 'actors.kind = agent cannot satisfy a role-gated approval (architecture §5)';
       END IF;
       RETURN NEW;
     END;
   $$ LANGUAGE plpgsql;`,
  'DROP TRIGGER IF EXISTS approvals_agent_never_approves_trg ON approvals;',
  `CREATE TRIGGER approvals_agent_never_approves_trg
     BEFORE INSERT ON approvals FOR EACH ROW
     EXECUTE FUNCTION approvals_agent_never_approves();`,

  `CREATE OR REPLACE FUNCTION gate_evidence_agent_claim_guard() RETURNS trigger AS $$
     DECLARE ev_producer TEXT; ev_kind TEXT;
     BEGIN
       SELECT producer, kind INTO ev_producer, ev_kind FROM evidence WHERE id = NEW.evidence_id;
       IF ev_producer = 'agent-claim' AND ev_kind <> 'knowledge-claim' THEN
         RAISE EXCEPTION 'agent-claim evidence may only back a knowledge-claim gate (ADR-0030)';
       END IF;
       RETURN NEW;
     END;
   $$ LANGUAGE plpgsql;`,
  'DROP TRIGGER IF EXISTS gate_evidence_agent_claim_guard_trg ON gate_evidence;',
  `CREATE TRIGGER gate_evidence_agent_claim_guard_trg
     BEFORE INSERT ON gate_evidence FOR EACH ROW
     EXECUTE FUNCTION gate_evidence_agent_claim_guard();`,
];

/**
 * Seeds `lifecycle_states` from core's canonical stage vocabulary.
 *
 * Data-driven per ADR-0009: the state machine is rows, and those rows are
 * derived from the same constant `REQUIRED_STAGES` resolves against — so a stage
 * cannot exist in code but be missing from the database.
 */
export async function seedLifecycleStates(db: SqlRunner): Promise<void> {
  for (const stage of LIFECYCLE_STAGES) {
    await db.query(
      `INSERT INTO lifecycle_states (key, is_terminal) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET is_terminal = EXCLUDED.is_terminal;`,
      [stage, isTerminalStage(stage)],
    );
  }
}

/**
 * Ledger of applied migrations.
 *
 * drizzle-kit emits bare `CREATE TABLE`, so replaying a migration fails rather
 * than no-opping. Recording what has run is what makes `db:up` on an existing
 * workspace safe — the alternative, wrapping every generated statement in
 * `IF NOT EXISTS`, would silently skip a genuinely conflicting change.
 */
export const MIGRATIONS_TABLE = '_sdlcof_migrations';

/** Migration filenames already applied to this database. */
export async function appliedMigrations(db: SqlRunner): Promise<Set<string>> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
  );
  const rows = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE};`);
  return new Set(rows.map((row) => row.name));
}

/**
 * Brings a database up to the current schema, applying only what it is missing.
 *
 * Idempotent: safe to run against an already-migrated database, which is what
 * makes `db:up` on an existing workspace a no-op rather than a hazard.
 */
export async function applySchema(db: SqlRunner): Promise<void> {
  // The extension must exist before the migration creates a `vector` column.
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');

  const already = await appliedMigrations(db);

  for (const file of await migrationFiles()) {
    const name = path.basename(file);
    if (already.has(name)) continue;

    const sql = await fs.readFile(file, 'utf8');
    // drizzle-kit separates statements with its own breakpoint marker.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await db.exec(trimmed);
    }
    await db.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1);`, [name]);
  }

  for (const statement of SUPPLEMENTAL_DDL) {
    await db.exec(statement);
  }

  await seedLifecycleStates(db);
}

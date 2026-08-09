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

  // Full-text indexes for the v0.1 tsvector-only retrieval path (mvp-slice).
  `CREATE INDEX IF NOT EXISTS work_items_title_tsv_idx ON work_items
     USING GIN (to_tsvector('english', title));`,
  `CREATE INDEX IF NOT EXISTS docs_title_tsv_idx ON docs
     USING GIN (to_tsvector('english', coalesce(title, '')));`,

  // Append-only audit log (ADR-0030). Never relaxed, not even for MVP —
  // architecture §5 lists it among the never-relaxed invariants.
  'REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;',
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

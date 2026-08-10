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

  // ── Scheduler state (P0-DB-05, FEAT-SCHED-001, ADR-0020) ──────────────────
  //
  // Budgets and rate-limit state live in the DB rather than in daemon memory
  // for one reason: a daemon restart must not reset them. An in-memory counter
  // that forgets on crash is not a budget, it is a suggestion — and the failure
  // shows up as a surprise bill or a provider ban, never as an error.
  `CREATE TABLE IF NOT EXISTS token_budgets (
     id            BIGSERIAL PRIMARY KEY,
     scope         TEXT NOT NULL,
     scope_id      TEXT NOT NULL,
     window_start  TIMESTAMPTZ NOT NULL,
     window_end    TIMESTAMPTZ NOT NULL,
     limit_tokens  BIGINT NOT NULL CHECK (limit_tokens > 0),
     used_tokens   BIGINT NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT token_budgets_scope_check CHECK (scope IN ('agent','work_item','workspace')),
     CONSTRAINT token_budgets_window_check CHECK (window_end > window_start)
   );`,
  // One live window per scope: without this, two windows overlap and "how much
  // is left" has two answers.
  `CREATE UNIQUE INDEX IF NOT EXISTS token_budgets_window_idx
     ON token_budgets (scope, scope_id, window_start);`,

  `CREATE TABLE IF NOT EXISTS provider_rate_limits (
     provider          TEXT PRIMARY KEY,
     requests_limit    INT,
     requests_remaining INT,
     tokens_limit      BIGINT,
     tokens_remaining  BIGINT,
     -- When the provider says the window resets. Stored as the provider
     -- reported it, never recomputed from a local clock: clock skew against a
     -- rate limiter is how a scheduler backs off for the wrong duration.
     resets_at         TIMESTAMPTZ,
     retry_after_ms    INT,
     observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // ── Already-happened ledger (P1-AGENT-04, ADR-0039) ───────────────────────
  //
  // Contract §6 deferred this to v0.2 behind a `runs.pr_url` stopgap; this is
  // v0.2. The primary key IS the idempotency key, so a duplicate attempt fails
  // to insert rather than being caught by a prior read — the read-then-write
  // version of this check loses exactly the race it exists to prevent, since
  // two resumed runs both read "not yet done" before either writes.
  `CREATE TABLE IF NOT EXISTS already_happened_ledger (
     idempotency_key TEXT PRIMARY KEY,
     work_item_id    TEXT NOT NULL,
     stage           TEXT NOT NULL,
     action_type     TEXT NOT NULL,
     -- What the world saw: a PR url, a release tag. Replayed on a retry so a
     -- caller gets the original outcome rather than an error.
     result          JSONB,
     happened_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  'CREATE INDEX IF NOT EXISTS already_happened_work_item_idx ON already_happened_ledger (work_item_id);',

  // ── Typed comments (P1-CMT-02, ADR-0012/0016) ─────────────────────────────
  //
  // Admitted into v0.1 with the contract note recorded in contracts/01: the
  // table and the dispatch ship now because the live-steering wiring is what
  // makes the injection defence real rather than declared. `author_role_id`
  // stays NULL until roles land, and the dispatch is total over the null-role
  // case, so an unroled comment resolves rather than falling through.
  `CREATE TABLE IF NOT EXISTS comments (
     id               BIGSERIAL PRIMARY KEY,
     work_item_id     TEXT NOT NULL REFERENCES work_items(id),
     author_actor_id  UUID REFERENCES actors(id),
     author_role_id   INT REFERENCES roles(id),
     type             TEXT NOT NULL CHECK (type IN
                        ('normal','agent-instruction','decision','blocker','bug-report','review','context-reference')),
     body             TEXT NOT NULL,
     -- Computed server-side at insert from (type × role) and never re-derived
     -- downstream (ADR-0012). This column, not the body, is what consumers read.
     role_effect      TEXT NOT NULL CHECK (role_effect IN
                        ('NONE','GATE_BLOCK','REQUIRED_CHANGE','DECISION_TO_MEMORY','RESCOPE',
                         'UX_ACCEPTANCE_UPDATE','CONTEXT_INJECTION','BUG_CREATION')),
     target_gate_key  TEXT,
     addressed_to     TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  'CREATE INDEX IF NOT EXISTS comments_work_item_idx ON comments (work_item_id, created_at);',
  // Immutable once written. A settable effect would let an edit convert an
  // ordinary comment into an instruction after the fact, which is the injection
  // vector re-opened through the back door.
  `CREATE OR REPLACE FUNCTION comments_role_effect_immutable() RETURNS trigger AS $$
     BEGIN
       IF NEW.role_effect IS DISTINCT FROM OLD.role_effect THEN
         RAISE EXCEPTION 'comments.role_effect is immutable once written (ADR-0012)';
       END IF;
       RETURN NEW;
     END;
   $$ LANGUAGE plpgsql;`,
  'DROP TRIGGER IF EXISTS comments_role_effect_immutable_trg ON comments;',
  `CREATE TRIGGER comments_role_effect_immutable_trg
     BEFORE UPDATE ON comments FOR EACH ROW
     EXECUTE FUNCTION comments_role_effect_immutable();`,

  // ── Traceability graph (P1-GATE-08, ADR-0032) ─────────────────────────────
  //
  // The Evidence Engine already produces every fact an edge needs — test
  // results, claim/citation records, the commit under test. What it never did
  // was *keep* them connected: after a gate verdict, the connective tissue was
  // discarded, so "which requirement does this code satisfy, and what proves
  // it" was answerable only by re-running the gate or reconstructing history by
  // hand. This is a retention change, not a new pipeline.
  //
  // Nullable columns throughout, deliberately. A partial edge is the normal
  // state: evidence usually arrives before anyone has linked it to a criterion,
  // and refusing to record the half we have would mean recording nothing until
  // the graph was already complete.
  `CREATE TABLE IF NOT EXISTS traceability_edges (
     id            BIGSERIAL PRIMARY KEY,
     work_item_id  TEXT NOT NULL REFERENCES work_items(id),
     -- The requirement end: an acceptance criterion, and the spec or change it
     -- came from when one is known.
     ac_id         TEXT,
     spec_id       TEXT,
     change_id     TEXT,
     -- The implementation end.
     commit_sha    TEXT,
     file_path     TEXT,
     -- The proof end.
     test_id       TEXT,
     evidence_id   BIGINT REFERENCES evidence(id),
     -- How this edge came to exist. A hand-asserted link and one derived from a
     -- gate run are different claims, and a graph that cannot tell them apart
     -- cannot be audited.
     origin        TEXT NOT NULL DEFAULT 'gate-evaluation',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT traceability_origin_check
       CHECK (origin IN ('gate-evaluation','claim-verification','manual')),
     -- An edge that connects nothing is a row, not a fact.
     CONSTRAINT traceability_endpoints_check
       CHECK (ac_id IS NOT NULL OR file_path IS NOT NULL OR evidence_id IS NOT NULL)
   );`,
  'CREATE INDEX IF NOT EXISTS traceability_work_item_idx ON traceability_edges (work_item_id);',
  'CREATE INDEX IF NOT EXISTS traceability_ac_idx ON traceability_edges (ac_id);',
  'CREATE INDEX IF NOT EXISTS traceability_evidence_idx ON traceability_edges (evidence_id);',
  // One row per *link*, and `evidence_id` is deliberately not part of the key.
  //
  // Every re-run produces new evidence, so keying on it would give each run its
  // own row and the coverage metric would climb every time a suite was re-run —
  // exactly the number ADR-0032 warns about. The link is the fact; the evidence
  // is the current proof of it, and the insert overwrites it so the graph
  // answers "covered by current tests against the current implementation"
  // rather than "was covered once, by something".
  `CREATE UNIQUE INDEX IF NOT EXISTS traceability_edge_uniq
     ON traceability_edges (
       work_item_id,
       COALESCE(ac_id,''),
       COALESCE(file_path,''),
       COALESCE(test_id,''),
       origin
     );`,

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

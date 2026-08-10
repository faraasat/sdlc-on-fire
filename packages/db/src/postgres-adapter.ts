import { canonicalJsonHash } from '@sdlc-on-fire/core';
import type {
  AuditChainVerification,
  BudgetScope,
  BudgetState,
  BudgetWindow,
  TokenCharge,
  AuditEntry,
  AuditRecord,
  ChunkHit,
  ClaimKind,
  ClaimRequest,
  ClaimState,
  ChunkRecord,
  DocMirror,
  MirrorStage,
  MirrorTable,
  StorageCapabilities,
  StoragePort,
  WorkItemMirror,
} from '@sdlc-on-fire/core';

/**
 * The Postgres adapter for {@link StoragePort} (ADR-0047, P0-DB-07).
 *
 * This is the *only* module in the system that knows our data lives in
 * Postgres. Everything above it speaks the port's vocabulary, which is what
 * makes a second store an adapter rather than a rewrite.
 *
 * It deliberately does **not** re-export its executor. Handing callers a way to
 * run arbitrary SQL would rebuild the coupling the port exists to remove — the
 * seam only holds if going around it is inconvenient.
 */

/** The minimal driver surface an adapter needs. Satisfied by PGlite and node-postgres alike. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs `fn` with exclusive, single-connection use of the database.
   *
   * Not optional in practice, and the reason is worth stating: issuing `BEGIN`
   * and `COMMIT` as ordinary queries does not produce a transaction on either
   * driver we support. A connection *pool* hands each statement to whichever
   * client is free, so `BEGIN` and the `INSERT` after it can land on different
   * connections — the transaction never exists and the `BEGIN` leaks. A
   * single-connection driver has the mirror-image problem: concurrent callers
   * interleave their statements in one session, so every `BEGIN` after the first
   * is a warning and the first `COMMIT` ends everyone's work.
   *
   * Both failures are silent. Neither is visible until data is already wrong.
   */
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** `embeddings.model` for a chunk indexed but not embedded (v0.1 is tsvector-only). */
export const UNEMBEDDED_MODEL = 'none';

/**
 * Probes what this database can actually do.
 *
 * Reads the catalog rather than trusting configuration: a connection string
 * that mentions Supabase proves nothing about whether `vector` is installed on
 * the database it points at.
 */
export async function probeStorageCapabilities(
  executor: SqlExecutor,
): Promise<StorageCapabilities> {
  const extensions = await executor.query<{ extname: string }>('SELECT extname FROM pg_extension;');
  const names = new Set(extensions.map((row) => row.extname));

  const tsv = await executor.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'embeddings' AND column_name = 'chunk_tsv';`,
  );

  return {
    vectorSearch: names.has('vector'),
    fullTextSearch: (tsv[0]?.n ?? 0) > 0,
    transactions: true,
  };
}

export class PostgresStorageAdapter implements StoragePort {
  readonly #executor: SqlExecutor;
  readonly capabilities: StorageCapabilities;
  /** Tail of the serialisation chain used when the driver offers no transaction. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(executor: SqlExecutor, capabilities: StorageCapabilities) {
    this.#executor = executor;
    this.capabilities = capabilities;
  }

  /** Probes capabilities, then binds them — so `capabilities` is never a guess. */
  static async create(executor: SqlExecutor): Promise<PostgresStorageAdapter> {
    return new PostgresStorageAdapter(executor, await probeStorageCapabilities(executor));
  }

  /**
   * Runs `fn` atomically, however this driver can manage it.
   *
   * Prefers the driver's own transaction. Failing that, serialises against every
   * other call on this adapter so at least the statements do not interleave —
   * weaker than a transaction, but it turns a silently corrupt result into a
   * correct-but-slower one.
   */
  async #atomic<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.#executor.transaction !== undefined) {
      return this.#executor.transaction(fn);
    }
    const run = this.#queue.then(
      () => fn(this.#executor),
      () => fn(this.#executor),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async upsertWorkItem(row: WorkItemMirror): Promise<void> {
    await this.#executor.query(
      `INSERT INTO work_items
         (id, type, title, status, lifecycle_state, work_type, preset, risk_level, parent_id, file_path, content_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type, title = EXCLUDED.title, status = EXCLUDED.status,
         lifecycle_state = EXCLUDED.lifecycle_state, work_type = EXCLUDED.work_type,
         preset = EXCLUDED.preset, risk_level = EXCLUDED.risk_level,
         parent_id = EXCLUDED.parent_id,
         file_path = EXCLUDED.file_path, content_hash = EXCLUDED.content_hash,
         updated_at = now();`,
      [
        row.id,
        row.type,
        row.title,
        row.status,
        row.lifecycleState,
        row.workType ?? null,
        row.preset ?? null,
        row.riskLevel ?? null,
        row.parentId ?? null,
        row.filePath,
        row.contentHash,
      ],
    );
  }

  async upsertDoc(row: DocMirror): Promise<void> {
    await this.#executor.query(
      `INSERT INTO docs (id, doc_type, file_path, content_hash, title, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET
         doc_type = EXCLUDED.doc_type, file_path = EXCLUDED.file_path,
         content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
         metadata = EXCLUDED.metadata, updated_at = now();`,
      [
        row.id,
        row.docType,
        row.filePath,
        row.contentHash,
        row.title ?? null,
        JSON.stringify(row.metadata ?? {}),
      ],
    );
  }

  async contentHashFor(table: MirrorTable, filePath: string): Promise<string | null> {
    const rows = await this.#executor.query<{ content_hash: string }>(
      `SELECT content_hash FROM ${assertTable(table)} WHERE file_path = $1;`,
      [filePath],
    );
    return rows[0]?.content_hash ?? null;
  }

  async mirroredPaths(table: MirrorTable): Promise<readonly { id: string; filePath: string }[]> {
    const rows = await this.#executor.query<{ id: string; file_path: string }>(
      `SELECT id, file_path FROM ${assertTable(table)};`,
    );
    return rows.map((row) => ({ id: row.id, filePath: row.file_path }));
  }

  async removeByPath(table: MirrorTable, filePath: string): Promise<void> {
    const name = assertTable(table);
    const owner = await this.#executor.query<{ id: string }>(
      `SELECT id FROM ${name} WHERE file_path = $1;`,
      [filePath],
    );
    await this.#executor.query(`DELETE FROM ${name} WHERE file_path = $1;`, [filePath]);

    const id = owner[0]?.id;
    if (id === undefined) return;
    // Hard delete, not a tombstone: the file is gone from git, so there is no
    // source to reconcile against and a stale chunk would retrieve as truth.
    await this.#executor.query(
      'DELETE FROM embeddings WHERE source_table = $1 AND source_id = $2;',
      [name, id],
    );
  }

  async replaceChunks(
    table: MirrorTable,
    sourceId: string,
    chunks: readonly ChunkRecord[],
  ): Promise<void> {
    const name = assertTable(table);
    await this.#atomic(async (tx) => {
      await tx.query('DELETE FROM embeddings WHERE source_table = $1 AND source_id = $2;', [
        name,
        sourceId,
      ]);
      for (const chunk of chunks) {
        await tx.query(
          `INSERT INTO embeddings
             (source_table, source_id, chunk_index, chunk_text, content_hash, model, heading_breadcrumb)
           VALUES ($1,$2,$3,$4,$5,$6,$7);`,
          [
            name,
            sourceId,
            chunk.index,
            chunk.text,
            chunk.contentHash,
            UNEMBEDDED_MODEL,
            chunk.breadcrumb ?? null,
          ],
        );
      }
    });
  }

  async searchChunks(query: string, limit: number): Promise<readonly ChunkHit[]> {
    // Honour the probe rather than issuing SQL that would throw. An adapter
    // without full-text support returns nothing, which callers already handle.
    if (!this.capabilities.fullTextSearch) return [];

    const rows = await this.#executor.query<{
      source_table: string;
      source_id: string;
      chunk_index: number;
      chunk_text: string;
      heading_breadcrumb: string | null;
      rank: number;
    }>(
      `SELECT source_table, source_id, chunk_index, chunk_text, heading_breadcrumb,
              ts_rank_cd(chunk_tsv, websearch_to_tsquery('english', $1)) AS rank
         FROM embeddings
        WHERE chunk_tsv @@ websearch_to_tsquery('english', $1)
          AND tombstoned_at IS NULL
        ORDER BY rank DESC
        LIMIT $2;`,
      [query, limit],
    );

    return rows.map((row) => ({
      sourceTable: row.source_table as MirrorTable,
      sourceId: row.source_id,
      index: row.chunk_index,
      text: row.chunk_text,
      score: Number(row.rank),
      ...(row.heading_breadcrumb === null ? {} : { breadcrumb: row.heading_breadcrumb }),
    }));
  }

  async claim(request: ClaimRequest): Promise<ClaimState | null> {
    // One statement. The WHERE clause is the entire concurrency control: a row
    // is claimable only if nobody holds it, the previous lease has lapsed, or
    // the caller already holds it (in which case this renews). Splitting this
    // into a SELECT then an UPDATE would reintroduce the race the claim exists
    // to close, and the window is exactly wide enough to lose a work item to
    // two actors on a fast machine.
    const rows = await this.#executor.query<ClaimRow>(
      `UPDATE work_items
          SET claimed_by = $2,
              claim_kind = $3,
              claimed_at = now(),
              lease_expires_at = now() + make_interval(secs => $4)
        WHERE id = $1
          AND (claimed_by IS NULL OR lease_expires_at <= now() OR claimed_by = $2)
        RETURNING id, claimed_by, claim_kind, claimed_at, lease_expires_at;`,
      [request.workItemId, request.actor, request.kind, request.leaseMs / 1000],
    );
    const row = rows[0];
    return row === undefined ? null : toClaimState(row);
  }

  async releaseClaim(workItemId: string, actor: string): Promise<boolean> {
    // Scoped to the holder: releasing someone else's claim is not a release,
    // it is a break-claim, which ADR-0048 requires to be an audited path.
    const rows = await this.#executor.query<{ id: string }>(
      `UPDATE work_items
          SET claimed_by = NULL, claim_kind = NULL, claimed_at = NULL, lease_expires_at = NULL
        WHERE id = $1 AND claimed_by = $2
        RETURNING id;`,
      [workItemId, actor],
    );
    return rows.length > 0;
  }

  async claimOf(workItemId: string): Promise<ClaimState | null> {
    // An expired lease is reported as no claim. Leaving it visible would let a
    // crashed actor appear to still hold work forever, which is the failure
    // leases exist to prevent.
    const rows = await this.#executor.query<ClaimRow>(
      `SELECT id, claimed_by, claim_kind, claimed_at, lease_expires_at
         FROM work_items
        WHERE id = $1 AND claimed_by IS NOT NULL AND lease_expires_at > now();`,
      [workItemId],
    );
    const row = rows[0];
    return row === undefined ? null : toClaimState(row);
  }

  async appendAudit(entry: AuditEntry): Promise<AuditRecord> {
    return this.#atomic(async (tx) => {
      const tip = await tx.query<{ record_hash: string }>(
        'SELECT record_hash FROM audit_log ORDER BY id DESC LIMIT 1;',
      );
      const prevHash = tip[0]?.record_hash ?? null;

      // The hash covers the link *and* the payload, so neither editing a row
      // nor reordering rows survives verification.
      const recordHash = canonicalJsonHash({
        prev: prevHash,
        action: entry.action,
        actorId: entry.actorId ?? null,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        detail: entry.detail ?? null,
      });

      const rows = await tx.query<{ id: number }>(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, prev_hash, record_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id;`,
        [
          entry.actorId ?? null,
          entry.action,
          entry.targetType ?? null,
          entry.targetId ?? null,
          entry.detail === undefined ? null : JSON.stringify(entry.detail),
          prevHash,
          recordHash,
        ],
      );

      return { ...entry, id: rows[0]?.id ?? 0, prevHash, recordHash };
    });
  }

  async verifyAuditChain(): Promise<AuditChainVerification> {
    const rows = await this.#executor.query<AuditRow>(
      `SELECT id, actor_id, action, target_type, target_id, detail, prev_hash, record_hash
         FROM audit_log ORDER BY id ASC;`,
    );

    const brokenAt: number[] = [];
    let expectedPrev: string | null = null;

    for (const row of rows) {
      // Two independent checks: the link points where it should, and the stored
      // hash still matches the row's own content. A tamperer who fixes only one
      // of those is caught by the other.
      const linkOk = (row.prev_hash ?? null) === expectedPrev;
      const recomputed = canonicalJsonHash({
        prev: row.prev_hash ?? null,
        action: row.action,
        actorId: row.actor_id ?? null,
        targetType: row.target_type ?? null,
        targetId: row.target_id ?? null,
        detail: row.detail ?? null,
      });
      if (!linkOk || recomputed !== row.record_hash) brokenAt.push(row.id);
      expectedPrev = row.record_hash;
    }

    return {
      ok: brokenAt.length === 0,
      checked: rows.length,
      brokenAt,
      ...(brokenAt.length === 0
        ? {}
        : {
            reason:
              `audit chain broken at ${brokenAt.length} row(s), first at id ${String(brokenAt[0])} — ` +
              'a row was edited, deleted, or inserted out of order.',
          }),
    };
  }

  async setBudget(budget: BudgetWindow): Promise<void> {
    await this.#executor.query(
      `INSERT INTO token_budgets (scope, scope_id, window_start, window_end, limit_tokens)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (scope, scope_id, window_start) DO UPDATE SET
         window_end = EXCLUDED.window_end, limit_tokens = EXCLUDED.limit_tokens, updated_at = now();`,
      [
        budget.scope,
        budget.scopeId,
        budget.windowStart.toISOString(),
        budget.windowEnd.toISOString(),
        budget.limitTokens,
      ],
    );
  }

  async budgetFor(scope: BudgetScope, scopeId: string, at: Date): Promise<BudgetState | null> {
    const rows = await this.#executor.query<BudgetRow>(
      `SELECT scope, scope_id, limit_tokens, used_tokens FROM token_budgets
        WHERE scope = $1 AND scope_id = $2 AND window_start <= $3 AND window_end > $3;`,
      [scope, scopeId, at.toISOString()],
    );
    const row = rows[0];
    return row === undefined ? null : toBudgetState(row);
  }

  async chargeTokens(charge: TokenCharge): Promise<BudgetState | null> {
    // One conditional UPDATE, for the same reason the claim is: read-then-write
    // lets two agents both see room and both spend it, and a budget that can be
    // overspent by concurrency is an estimate wearing a limit's name. The
    // `used_tokens + $4 <= limit_tokens` predicate is the enforcement.
    const rows = await this.#executor.query<BudgetRow>(
      `UPDATE token_budgets
          SET used_tokens = used_tokens + $4, updated_at = now()
        WHERE scope = $1 AND scope_id = $2
          AND window_start <= $3 AND window_end > $3
          AND used_tokens + $4 <= limit_tokens
        RETURNING scope, scope_id, limit_tokens, used_tokens;`,
      [charge.scope, charge.scopeId, charge.at.toISOString(), charge.tokens],
    );
    const row = rows[0];
    return row === undefined ? null : toBudgetState(row);
  }

  async claimAction(input: {
    key: string;
    workItemId: string;
    stage: string;
    action: string;
  }): Promise<{ first: boolean; result: unknown }> {
    // ON CONFLICT DO NOTHING makes the primary key the arbiter. A row comes
    // back only for the caller that actually inserted it; everyone else gets
    // nothing and must read the existing result. No read-then-write window.
    const inserted = await this.#executor.query<{ idempotency_key: string }>(
      `INSERT INTO already_happened_ledger (idempotency_key, work_item_id, stage, action_type)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key;`,
      [input.key, input.workItemId, input.stage, input.action],
    );
    if (inserted.length > 0) return { first: true, result: null };

    const existing = await this.#executor.query<{ result: unknown }>(
      'SELECT result FROM already_happened_ledger WHERE idempotency_key = $1;',
      [input.key],
    );
    return { first: false, result: existing[0]?.result ?? null };
  }

  async recordActionResult(key: string, result: unknown): Promise<void> {
    await this.#executor.query(
      'UPDATE already_happened_ledger SET result = $2::jsonb WHERE idempotency_key = $1;',
      [key, JSON.stringify(result)],
    );
  }

  async resetMirror(): Promise<void> {
    // Order matters only for readability — `embeddings` has no FK to the mirror
    // tables (contract 01 §2 keeps `source_id` polymorphic and unconstrained),
    // so a dangling chunk is self-healing rather than a constraint violation.
    // `evidence`, `gates`, `approvals` and `audit_log` are untouched by design.
    await this.#executor.query('DELETE FROM embeddings;');
    await this.#executor.query('DELETE FROM docs;');
    await this.#executor.query('DELETE FROM work_items;');
  }

  async stageOf(workItemId: string): Promise<MirrorStage | null> {
    const rows = await this.#executor.query<{ lifecycle_state: string; status: string }>(
      'SELECT lifecycle_state, status FROM work_items WHERE id = $1;',
      [workItemId],
    );
    const row = rows[0];
    return row === undefined ? null : { lifecycleState: row.lifecycle_state, status: row.status };
  }
}

/**
 * Guards the one place a table name reaches SQL as an identifier.
 *
 * `MirrorTable` is a closed union, so a valid caller cannot get here with
 * anything else — but identifiers cannot be parameterised, and "the type system
 * said so" is not a control at a SQL boundary reachable from parsed frontmatter.
 */
function assertTable(table: MirrorTable): 'work_items' | 'docs' {
  if (table !== 'work_items' && table !== 'docs') {
    throw new Error(`unknown mirror table: ${String(table)}`);
  }
  return table;
}

interface ClaimRow {
  id: string;
  claimed_by: string | null;
  claim_kind: string | null;
  claimed_at: Date | string | null;
  lease_expires_at: Date | string | null;
}

/** Normalises a claim row, with timestamps as ISO strings so the port stays driver-agnostic. */
function toClaimState(row: ClaimRow): ClaimState {
  const iso = (value: Date | string | null): string =>
    value === null ? '' : value instanceof Date ? value.toISOString() : value;
  return {
    workItemId: row.id,
    claimedBy: row.claimed_by ?? '',
    claimKind: (row.claim_kind ?? 'agent') as ClaimKind,
    claimedAt: iso(row.claimed_at),
    leaseExpiresAt: iso(row.lease_expires_at),
  };
}

interface AuditRow {
  id: number;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  prev_hash: string | null;
  record_hash: string;
}

interface BudgetRow {
  scope: string;
  scope_id: string;
  limit_tokens: string | number;
  used_tokens: string | number;
}

/**
 * Normalises a budget row.
 *
 * `BIGINT` comes back as a string from node-postgres (a bigint can exceed
 * `Number.MAX_SAFE_INTEGER`, so the driver refuses to guess). Token counts are
 * nowhere near that, but the *types* differ between drivers, and arithmetic on
 * a string silently concatenates.
 */
function toBudgetState(row: BudgetRow): BudgetState {
  const limit = Number(row.limit_tokens);
  const used = Number(row.used_tokens);
  return {
    scope: row.scope as BudgetScope,
    scopeId: row.scope_id,
    limitTokens: limit,
    usedTokens: used,
    remainingTokens: Math.max(0, limit - used),
  };
}

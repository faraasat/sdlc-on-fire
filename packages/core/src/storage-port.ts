import type { RunFinish, RunStart } from './run-record.js';
/**
 * The `StoragePort` — the single interface through which data is pulled and
 * sent (ADR-0047).
 *
 * Two rules give this file its shape, and both are load-bearing:
 *
 * 1. **Ports never import adapters.** Nothing here may reference Postgres,
 *    Drizzle, PGlite, or SQL. This module is types and vocabulary only; it sits
 *    in `core` precisely so every consumer can depend on it without dragging a
 *    database in.
 *
 * 2. **No raw-SQL escape hatch.** The obvious shortcut — a `query(sql)` method —
 *    would make every caller a Postgres caller again and reduce the port to
 *    "Postgres with extra steps", the failure ADR-0047 explicitly names. So the
 *    surface is *operation-oriented* (upsert this item, replace these chunks,
 *    search, claim) rather than a thin wrapper over a driver. An operation the
 *    port cannot express is a gap to close by adding an operation, not by
 *    smuggling a string through.
 *
 * Store-specific power is preserved through {@link StorageCapabilities} rather
 * than erased to a lowest common denominator: an adapter without vector search
 * says so, and callers degrade instead of breaking.
 */

import type { MemoryEntry } from './memory-entry.js';

/**
 * What a given adapter can actually do.
 *
 * Probed from the live store, never assumed from its name — a Postgres without
 * the `vector` extension is not a vector store, and finding that out at query
 * time is finding out too late.
 */
export interface StorageCapabilities {
  /** pgvector (or equivalent) is present, so embedding search is possible. */
  readonly vectorSearch: boolean;
  /** Full-text search over chunk content is available. */
  readonly fullTextSearch: boolean;
  /** Multi-statement atomicity is available. */
  readonly transactions: boolean;
}

/** Which mirror table a row belongs to. The set is closed by contract 01 §2. */
export type MirrorTable = 'work_items' | 'docs';

/** A work-item card as mirrored from its file. Rebuildable, never authoritative. */
export interface WorkItemMirror {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly lifecycleState: string;
  readonly workType?: string | undefined;
  readonly preset?: string | undefined;
  readonly riskLevel?: string | undefined;
  /**
   * The item this one hangs from — the epic above a feature, the feature above
   * a task.
   *
   * The column and its index shipped with the schema and nothing ever wrote to
   * them, so every hierarchy question ("what epic is this under?") had no answer
   * in the mirror despite the cards carrying `parent_id` all along. Branch names
   * derive from this chain (ADR-0048), which is what finally made the gap
   * visible.
   */
  readonly parentId?: string | null | undefined;
  readonly filePath: string;
  readonly contentHash: string;
}

/** Any non-work-item markdown file, mirrored. */
export interface DocMirror {
  readonly id: string;
  readonly docType: string;
  readonly filePath: string;
  readonly contentHash: string;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** One chunk of a document's body, as stored for retrieval. */
export interface ChunkRecord {
  readonly index: number;
  readonly text: string;
  readonly contentHash: string;
  readonly breadcrumb?: string | undefined;
}

/** A chunk that matched a search, with its score. */
export interface ChunkHit {
  readonly sourceTable: MirrorTable;
  readonly sourceId: string;
  readonly index: number;
  readonly text: string;
  readonly score: number;
  readonly breadcrumb?: string | undefined;
}

/** Who may hold a claim (ADR-0048). */
export type ClaimKind = 'agent' | 'human';

/** A live claim on a work item. */
export interface ClaimState {
  readonly workItemId: string;
  readonly claimedBy: string;
  readonly claimKind: ClaimKind;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimRequest {
  readonly workItemId: string;
  readonly actor: string;
  readonly kind: ClaimKind;
  /** How long the claim survives without renewal. */
  readonly leaseMs: number;
}

/** One entry in the hash-chained audit log (ADR-0030). */
export interface AuditEntry {
  readonly action: string;
  /**
   * A registered actor's **uuid**, not a name.
   *
   * `audit_log.actor_id` is an FK into `actors`. The free-text identity a claim
   * is held under (`work_items.claimed_by`, `--as ada`) is a different thing and
   * belongs in {@link AuditEntry.detail}.
   */
  readonly actorId?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
}

/** An appended entry, with the chain links the store assigned it. */
export interface AuditRecord extends AuditEntry {
  readonly id: number;
  readonly prevHash: string | null;
  readonly recordHash: string;
}

/** What a chain verification found. */
export interface AuditChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  /** Ids where the chain broke, in order. Empty when `ok`. */
  readonly brokenAt: readonly number[];
  readonly reason?: string | undefined;
}

/** What a token budget is scoped to. */
export type BudgetScope = 'agent' | 'work_item' | 'workspace';

export interface BudgetWindow {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly limitTokens: number;
}

export interface BudgetState {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly limitTokens: number;
  readonly usedTokens: number;
  readonly remainingTokens: number;
}

export interface TokenCharge {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly tokens: number;
  readonly at: Date;
}

/** The stage a work item is recorded at. */
export interface MirrorStage {
  readonly lifecycleState: string;
  readonly status: string;
}

/**
 * The data plane.
 *
 * Every method is an operation with meaning in this domain, so an adapter for a
 * different store implements *intent* rather than translating SQL. Methods are
 * grouped by the subsystem that drives them.
 */

export interface StoragePort {
  readonly capabilities: StorageCapabilities;

  /* ---- content mirror (Storage Manager sync) ---- */

  /**
   * Records a memory entry, applying bi-temporal conflict resolution first
   * (P1-OBJ-04, ADR-0023).
   *
   * The resolution is computed by `resolveConflicts` and *applied* here — the
   * decision is a pure function so it can be reasoned about and tested without a
   * database, and the write is the only part that needs one. Returns `null` when
   * the claim already exists: re-asserting a belief is not a correction, and
   * recording it again is the accumulation failure this design exists to avoid.
   */
  recordMemory(entry: MemoryEntry): Promise<MemoryEntry | null>;
  /** Entries currently believed, most salient first. */
  currentMemory(filter?: {
    workItemId?: string | undefined;
    type?: string | undefined;
  }): Promise<readonly MemoryEntry[]>;
  /** Every entry about a subject, including closed ones — the "why did we change our mind" trail. */
  memoryHistory(title: string): Promise<readonly MemoryEntry[]>;

  /* ---- agent runs (P6-WRITEPATH-01) ---- */

  /**
   * Record that a run has begun, as `running`.
   *
   * Written *before* the work starts. A row created on completion never exists
   * for a dispatch that hung, crashed or was killed — and those are exactly the
   * runs somebody goes looking for.
   */
  startRun(run: RunStart): Promise<void>;

  /**
   * Record how a run ended.
   *
   * Must be called on the failure path too, or every failed run stays `running`
   * forever and "currently running" comes to mean "started at some point".
   */
  finishRun(run: RunFinish): Promise<void>;

  upsertWorkItem(row: WorkItemMirror): Promise<void>;
  upsertDoc(row: DocMirror): Promise<void>;

  /** The hash currently mirrored for a path, or `null` when it is not mirrored. */
  contentHashFor(table: MirrorTable, filePath: string): Promise<string | null>;

  /** Every mirrored path in a table — the input to reconcile's prune pass. */
  mirroredPaths(table: MirrorTable): Promise<readonly { id: string; filePath: string }[]>;

  /** Removes a mirrored row and everything derived from it. Idempotent. */
  removeByPath(table: MirrorTable, filePath: string): Promise<void>;

  /* ---- retrieval (Context Manager) ---- */

  /**
   * Replaces every chunk for one source, atomically where the adapter supports
   * it. Replace rather than diff: chunk boundaries move when a heading changes,
   * so chunk 4 before and chunk 4 after are not the same unit.
   */
  replaceChunks(
    table: MirrorTable,
    sourceId: string,
    chunks: readonly ChunkRecord[],
  ): Promise<void>;

  /** Full-text search over chunk content. Empty when `fullTextSearch` is false. */
  searchChunks(query: string, limit: number): Promise<readonly ChunkHit[]>;

  /* ---- lifecycle ---- */

  stageOf(workItemId: string): Promise<MirrorStage | null>;

  /* ---- claim / lease (ADR-0048) ---- */

  /**
   * Acquires or renews a claim, atomically.
   *
   * Returns `null` when another actor holds a live claim. This **must** be a
   * single conditional write, not read-then-write: two actors who both read
   * "unclaimed" and then both write their own name is precisely the race
   * ADR-0048 exists to prevent, and it is the reason an advisory status field
   * was rejected as the mechanism.
   *
   * Re-claiming as the current holder renews the lease rather than failing —
   * an actor should not have to release and race for its own work.
   */
  claim(request: ClaimRequest): Promise<ClaimState | null>;

  /** Releases a claim. `false` when the caller does not hold it. */
  releaseClaim(workItemId: string, actor: string): Promise<boolean>;

  /** The live claim, or `null` when unclaimed **or** the lease has expired. */
  claimOf(workItemId: string): Promise<ClaimState | null>;

  /* ---- audit log (ADR-0030) ---- */

  /**
   * Appends one entry, computing its chain link.
   *
   * Append must be **serialised**: two concurrent appends that both read the
   * same `prev_hash` produce a fork, and a forked chain verifies as broken
   * forever after. The adapter is responsible for making that impossible, not
   * for hoping it does not happen.
   */
  appendAudit(entry: AuditEntry): Promise<AuditRecord>;

  /**
   * Walks the chain and reports the first place it breaks.
   *
   * Architecture §5 lists this invariant as never-relaxed, which only means
   * anything if something actually checks it — a hash column nobody verifies is
   * decoration.
   *
   * **Known limit:** a bare hash chain cannot detect *truncation*. Deleting rows
   * from the tail leaves a shorter but internally consistent chain, and this
   * returns `ok`. Catching that needs an anchor held outside the log — an
   * expected tip hash or row count — which this table does not yet carry. Stated
   * here so "hash-chained" is not read as "tamper-proof against deletion".
   */
  verifyAuditChain(): Promise<AuditChainVerification>;

  /* ---- scheduler budgets (P0-DB-05) ---- */

  /**
   * Charges tokens against a budget window, atomically.
   *
   * Returns the state after charging, or `null` when the charge would exceed
   * the limit — in which case **nothing is recorded**. Read-then-write here
   * would let two agents both see room and both spend it, which is how a budget
   * becomes an estimate.
   */
  chargeTokens(charge: TokenCharge): Promise<BudgetState | null>;

  /** The current window's state, or `null` when no budget is configured. */
  budgetFor(scope: BudgetScope, scopeId: string, at: Date): Promise<BudgetState | null>;

  /** Declares (or replaces) a budget window. */
  setBudget(budget: BudgetWindow): Promise<void>;

  /* ---- already-happened ledger (P1-AGENT-04, ADR-0039) ---- */

  /**
   * Claims the right to perform a side-effecting action exactly once.
   *
   * Returns `{ first: true }` when this caller may proceed, or
   * `{ first: false, result }` when the action already happened — carrying the
   * original outcome so a resumed run gets the PR url it opened last time
   * rather than an error about a duplicate.
   *
   * The uniqueness must be enforced by the store, not by a prior read. Two runs
   * resuming after the same crash both read "not yet done" before either
   * writes, which is precisely the race that opens two pull requests.
   */
  claimAction(input: {
    readonly key: string;
    readonly workItemId: string;
    readonly stage: string;
    readonly action: string;
  }): Promise<{ first: boolean; result: unknown }>;

  /** Records what the action produced, once it has actually happened. */
  recordActionResult(key: string, result: unknown): Promise<void>;

  /* ---- rebuild ---- */

  /**
   * Empties every rebuildable mirror table.
   *
   * Scoped deliberately to the *mirror*: work items, docs, and their chunks are
   * caches of files in git and can be reconstructed. Evidence, gates, approvals
   * and the audit log are **not** — they are the authoritative record of what
   * was verified and by whom, and no rebuild may touch them. `db:rebuild` that
   * silently discarded evidence would turn a maintenance command into a way to
   * launder a failing gate.
   */
  resetMirror(): Promise<void>;
}

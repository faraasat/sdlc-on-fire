import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Drizzle schema for the v0.1 MVP table subset, per contracts/01-db-schema.md
 * §3 and its §5 MVP cut.
 *
 * Two things this schema is *not*:
 *
 *   - It is not authoritative for content. `work_items` and `docs` are a
 *     rebuildable mirror of git (architecture §5, invariant 1); `db:rebuild`
 *     drops and reconstructs them from `.sdlc/` at any time.
 *   - It is not the full plan. Tables deferred past v0.1 that are nonetheless
 *     *created* here — `approvals`, `embeddings`, `roles` — exist so later
 *     phases add rows rather than a schema-breaking migration (§5).
 */

/* ------------------------------------------------------------------ lifecycle */

/**
 * Data-driven per ADR-0009: stage identity lives in rows, not an embedded chart.
 * `REQUIRED_STAGES[preset][work_type]` in `core` resolves against these keys.
 */
export const lifecycleStates = pgTable('lifecycle_states', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  description: text('description'),
  /** Gates the immutability invariant (architecture §5). */
  isTerminal: boolean('is_terminal').notNull().default(false),
});

/* ------------------------------------------------------------------- identity */

/** Humans and agents under one identity concept (ADR-0010). */
export const actors = pgTable(
  'actors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    displayName: text('display_name').notNull(),
    /** Humans: bootstrapped from git config user.email. */
    email: text('email'),
    /** Agents: claude-code | codex | … */
    agentTarget: text('agent_target'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('actors_kind_check', sql`${table.kind} IN ('human','agent')`)],
);

/**
 * Created but unpopulated in v0.1 — there is no RBAC yet (§5). It exists because
 * `gate_policies` and `approvals` carry foreign keys into it, and adding the
 * table later would be a schema-breaking migration.
 */
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  description: text('description'),
});

/**
 * Who holds which role, and until when (P3-RBAC-01, contract 01 §3.3).
 *
 * `expires_at` is the ADR-0035 amendment: grants are time-bounded, so a role
 * handed out for one release does not quietly become permanent. It is nullable
 * because most memberships are indefinite — but a check that reads the row
 * without reading the date makes every temporary grant permanent, and nothing
 * looks wrong. `capability()` in `core` is where that reading happens.
 */
export const memberships = pgTable(
  'memberships',
  {
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.actorId, table.roleId] })],
);

/** The action vocabulary. Rows, not an enum — the set grows per phase. */
export const permissions = pgTable('permissions', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  description: text('description'),
});

/**
 * The role side of `capability()`.
 *
 * Deliberately a plain join table with no conditions on it: ADR-0010 caps the
 * model at roughly eight roles and explicitly does not intend ABAC generality.
 * Anything card-specific belongs in a relationship grant, not in a predicate
 * column here.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id),
    permissionId: integer('permission_id')
      .notNull()
      .references(() => permissions.id),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })],
);

/* ---------------------------------------------------------------- content mirror */

export const workItems = pgTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    /** Kanban column — a read-side projection label, never independently authored. */
    status: text('status').notNull(),
    lifecycleState: text('lifecycle_state')
      .notNull()
      .references(() => lifecycleStates.key),
    workType: text('work_type'),
    preset: text('preset'),
    riskLevel: text('risk_level'),
    parentId: text('parent_id'),
    /** Source-of-truth Markdown path. Unique: one file, one work item. */
    filePath: text('file_path').notNull(),
    /** sha256 of file content — the sync hash-guard's no-op-vs-real-change check. */
    contentHash: text('content_hash').notNull(),
    gitCommitSha: text('git_commit_sha'),
    // Claim/lease (ADR-0048), acquired by atomic conditional write.
    claimedBy: text('claimed_by'),
    claimKind: text('claim_kind'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('work_items_file_path_key').on(table.filePath),
    index('work_items_lifecycle_state_idx').on(table.lifecycleState),
    index('work_items_parent_idx').on(table.parentId),
    /** Drives the reconnect catch-up query (architecture §4c). */
    index('work_items_updated_at_idx').on(table.updatedAt),
    index('work_items_claim_idx').on(table.claimedBy, table.leaseExpiresAt),
    check('work_items_type_check', sql`${table.type} IN ('epic','story','feature','bug','task')`),
    check('work_items_preset_check', sql`${table.preset} IN ('lite','standard','strict')`),
  ],
);

/** Mirror of every non-work-item Markdown file. */
export const docs = pgTable(
  'docs',
  {
    id: text('id').primaryKey(),
    docType: text('doc_type').notNull(),
    filePath: text('file_path').notNull(),
    contentHash: text('content_hash').notNull(),
    title: text('title'),
    /** doc_type-specific frontmatter passthrough. */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('docs_file_path_key').on(table.filePath),
    index('docs_doc_type_idx').on(table.docType),
    index('docs_updated_at_idx').on(table.updatedAt),
    check(
      'docs_doc_type_check',
      sql`${table.docType} IN ('spec','change','decision','research','risk','archive','constitution')`,
    ),
  ],
);

export const lifecycleTransitions = pgTable(
  'lifecycle_transitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id),
    /** NULL for the initial transition. */
    fromState: text('from_state').references(() => lifecycleStates.key),
    toState: text('to_state')
      .notNull()
      .references(() => lifecycleStates.key),
    actorId: uuid('actor_id').references(() => actors.id),
    /** Snapshot of evaluateGate's {pass, missing, failures} at transition time. */
    gateResult: jsonb('gate_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('lifecycle_transitions_work_item_idx').on(table.workItemId, table.createdAt)],
);

/* ---------------------------------------------------------------- gates & evidence */

/** The compiled row form of the Constitution/YAML policy source, not the source itself. */
export const gatePolicies = pgTable('gate_policies', {
  id: serial('id').primaryKey(),
  workType: text('work_type'),
  riskLevel: text('risk_level'),
  pathPattern: text('path_pattern'),
  requiredRoleId: integer('required_role_id').references(() => roles.id),
  minApprovals: integer('min_approvals').notNull().default(1),
  overridableByRoleId: integer('overridable_by_role_id').references(() => roles.id),
});

export const gates = pgTable(
  'gates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id),
    gateName: text('gate_name').notNull(),
    policyId: integer('policy_id').references(() => gatePolicies.id),
    result: text('result'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    /**
     * When the gate was raised (P6-INSTRUMENT-03, FEAT-MET-002).
     *
     * Blocked time is `evaluated_at - created_at`, and it was not derivable
     * before this existed: `updated_at` is a watermark that the resolving UPDATE
     * overwrites, so the moment the block *started* was destroyed by the moment
     * it ended. And `blocked` is deliberately not a lifecycle state, so
     * `lifecycle_transitions` cannot answer it either.
     */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Realtime watermark (contract 01 §3.11). Maintained by trigger, not by callers. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('gates_work_item_idx').on(table.workItemId),
    index('gates_updated_at_idx').on(table.updatedAt),
    check('gates_result_check', sql`${table.result} IN ('pending','pass','fail')`),
  ],
);

/** Schema created in Phase 0, unpopulated in v0.1 — no human-approval workflow yet (§5). */
export const approvals = pgTable(
  'approvals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    gateId: bigserial('gate_id', { mode: 'number' }).notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => actors.id),
    roleId: integer('role_id').references(() => roles.id),
    decision: text('decision').notNull(),
    reason: text('reason'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => actors.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'approvals_decision_check',
      sql`${table.decision} IN ('approve','request-changes','override')`,
    ),
    /** An override with no stated reason is an unexplained bypass. */
    check(
      'reason_required_on_override',
      sql`${table.decision} <> 'override' OR ${table.reason} IS NOT NULL`,
    ),
  ],
);

/** The evidence envelope (ADR-0030). Maps 1:1 onto core's `EvidenceEnvelopeSchema`. */
export const evidence = pgTable(
  'evidence',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    producer: text('producer').notNull(),
    gitSha: text('git_sha').notNull(),
    /** Set iff produced against an uncommitted worktree. */
    dirtyTreeHash: text('dirty_tree_hash'),
    env: jsonb('env').notNull(),
    command: jsonb('command'),
    /** sha256 of payload — content-addressed, survives the binary-artifact rolloff. */
    contentHash: text('content_hash').notNull(),
    signature: text('signature'),
    confidence: numeric('confidence').notNull(),
    producedAt: timestamp('produced_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('evidence_git_sha_idx').on(table.gitSha),
    index('evidence_kind_idx').on(table.kind),
    check(
      'evidence_producer_check',
      sql`${table.producer} IN ('ci','daemon','human','agent-claim')`,
    ),
    check('evidence_confidence_check', sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
);

export const gateEvidence = pgTable(
  'gate_evidence',
  {
    gateId: bigserial('gate_id', { mode: 'number' }).notNull(),
    evidenceId: bigserial('evidence_id', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.gateId, table.evidenceId] })],
);

/* ------------------------------------------------------------------------ runs */

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workItemId: text('work_item_id')
      .notNull()
      .references(() => workItems.id),
    skillId: text('skill_id'),
    agentTarget: text('agent_target'),
    model: text('model'),
    contextPackPath: text('context_pack_path'),
    status: text('status'),
    /**
     * Why a run did not succeed (P6-INSTRUMENT-02, contract 01 §3.5).
     *
     * Closed vocabulary, derived at the dispatch boundary from what actually
     * threw. Free text here would be uncountable, which is the whole point of
     * the column.
     */
    failureReason: text('failure_reason'),
    /**
     * Usage as the transport reported it (FEAT-MET-008). Nullable and left NULL
     * when nothing was reported — cost is recorded, never computed from a price
     * table that goes stale on the vendor's schedule.
     */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    /**
     * Prompt-cache accounting (P6-INSTRUMENT-03, FEAT-MET-011).
     *
     * The *rate*, not the cacheable fraction. `packMetrics.cacheableFraction`
     * already says how much of a pack could be cached, which is a property of
     * how it was ordered; whether it actually was is only knowable from what the
     * provider says it read.
     */
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    /**
     * Turns in the agentic loop, as the target reported them (FEAT-MET-013).
     *
     * Not tool calls. `--output-format json` does not carry tool calls, and
     * reporting turns under that name would be a substitution nobody could see.
     */
    turns: integer('turns'),
    /**
     * v0.1 stopgap for the deferred `already_happened_ledger` (contract §6
     * reconciliation call): PR creation is irreversible even in the walking
     * skeleton, so the URL of an already-opened PR is recorded here. The full
     * ledger lands in v0.2 with the rest of ADR-0039's durable-exec work.
     */
    prUrl: text('pr_url'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /**
     * Realtime watermark (contract 01 §3.11). Without it a client that missed a
     * `runs` update while disconnected could not discover it by any query — and
     * `runs` is the table a live board watches most closely.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('runs_work_item_idx').on(table.workItemId),
    index('runs_updated_at_idx').on(table.updatedAt),
    check('runs_status_check', sql`${table.status} IN ('pending','running','pass','fail','error')`),
    check(
      'runs_failure_reason_check',
      sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ('output-contract','forbidden-claim','transport','timeout','depth-cap')`,
    ),
  ],
);

/* ------------------------------------------------------------------- retrieval */

/**
 * Created in Phase 0 so the schema is complete, but **unused in v0.1**: the
 * walking skeleton includes card content directly in the context pack rather
 * than retrieving (§5), and embeddings are a v0.2 item.
 */
export const embeddings = pgTable('embeddings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sourceTable: text('source_table').notNull(),
  sourceId: text('source_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  chunkText: text('chunk_text').notNull(),
  /** Chunk-level hash — drives selective re-embed rather than whole-file re-embed. */
  contentHash: text('content_hash').notNull(),
  model: text('model').notNull(),
  /** 384-dim default (bge-small); widened per embedder config, indexable to 2000. */
  embedding: vector('embedding', { dimensions: 384 }),
  headingBreadcrumb: text('heading_breadcrumb'),
  /** Soft-delete marker for deleted/renamed sources. */
  tombstonedAt: timestamp('tombstoned_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------- audit log */

/**
 * Append-only and hash-chained (ADR-0030). The chain is **never relaxed**, not
 * even for MVP (architecture §5 lists it among the never-relaxed invariants).
 *
 * `record_hash` is computed by the daemon in Node `crypto` at insert time, not
 * by a `digest()` trigger — contract §6 resolved this so no `pgcrypto`
 * dependency is assumed, which also keeps the chain working on PGlite.
 */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: uuid('actor_id').references(() => actors.id),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  detail: jsonb('detail'),
  /** `record_hash` of the immediately preceding row; NULL for the genesis row. */
  prevHash: text('prev_hash'),
  recordHash: text('record_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Typed, provenance-tracked, bi-temporal memory (contract §3.7, ADR-0023).
 *
 * Two properties do the work, and both are refusals to delete.
 *
 * **Bi-temporal.** A correction closes `valid_to` and points `superseded_by` at
 * the replacement; the row stays. "What did we think, and when did we stop
 * thinking it" remains answerable — ADR-0013's immutability applied to belief.
 *
 * **Provenance.** `source_type` and `written_by` are `NOT NULL` because the
 * failure mode of a memory store is accumulation, not scarcity: a wrong
 * remembered fact is retrieved with exactly the same confidence as a right one.
 * An entry whose origin is unknown cannot be judged later.
 */
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** episodic | semantic | procedural | prospective. */
    type: text('type').notNull(),
    /** NULL for project-level memory belonging to no single item. */
    workItemId: text('work_item_id').references(() => workItems.id),
    /** The subject a claim is about — conflict detection groups on it. */
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** user-authored | agent-inferred | retrospective-synthesized. */
    sourceType: text('source_type').notNull(),
    /** Agent or skill name plus run id — who wrote this, concretely. */
    writtenBy: text('written_by').notNull(),
    /** Salience at write, assigned once. One weighted term in the score, never a gate. */
    importance: numeric('importance'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** NULL means currently believed. A close, never a delete. */
    validTo: timestamp('valid_to', { withTimezone: true }),
    supersededBy: bigint('superseded_by', { mode: 'number' }),
    /** none | superseded | contested. */
    conflictStatus: text('conflict_status').notNull().default('none'),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    contentHash: text('content_hash').notNull(),
    /** Backing `.sdlcof/memory/` file, when one exists. */
    filePath: text('file_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('memory_entries_type_idx').on(table.type),
    index('memory_entries_work_item_idx').on(table.workItemId),
    // `valid_to IS NULL` is the "currently believed" filter every read runs.
    index('memory_entries_valid_idx').on(table.validTo),
  ],
);

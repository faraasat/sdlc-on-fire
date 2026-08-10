import { z } from 'zod';
import { WorkItemIdSchema } from './ids.js';

/**
 * Typed, provenance-tracked, bi-temporal memory (P1-OBJ-04, ADR-0023,
 * contract §3.7).
 *
 * The failure mode of a memory store is accumulation, not scarcity: a wrong
 * remembered fact is retrieved with exactly the same confidence as a right one.
 * Everything here follows from that.
 *
 * **Typed**, so a read can filter before it ranks rather than treating a
 * one-off observation and a standing convention as the same kind of thing.
 *
 * **Provenance is required**, not optional. An entry whose origin is unknown
 * cannot be judged months later, and "the user said so" and "an agent inferred
 * it" are not the same claim — the 2026 survey literature names this as the
 * field's most consistently missing column, and it is cheap now and expensive to
 * retrofit.
 *
 * **Bi-temporal**, so a correction closes the old entry's validity window rather
 * than overwriting it. That is ADR-0013's immutability applied to belief: the
 * decision log keeps a "why did we change our mind" trail for free, and nothing
 * is ever silently rewritten.
 */

/** ADR-0023's taxonomy. `associative` is a retrieval mode, not a stored type. */
export const MEMORY_TYPES = ['episodic', 'semantic', 'procedural', 'prospective'] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MEMORY_TYPE_MEANING: Readonly<Record<MemoryType, string>> = {
  episodic: 'something that happened once, on a particular work item',
  semantic: 'a durable fact about this project',
  procedural: 'how something is done here — a convention',
  prospective: 'something to do or check later',
};

/** Where the claim came from. Never inferred, never defaulted. */
export const MEMORY_SOURCES = [
  'user-authored',
  'agent-inferred',
  'retrospective-synthesized',
] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

/**
 * Whether an entry is still believed, and if not, why not.
 *
 * `contested` is a real outcome, not a placeholder. Two entries can disagree
 * without either being decidably newer — a fact recorded today about last month
 * does not automatically beat one recorded last month. Marking both contested is
 * the honest answer; picking one would be a guess wearing a rule's clothing.
 */
export const CONFLICT_STATUSES = ['none', 'superseded', 'contested'] as const;
export const ConflictStatusSchema = z.enum(CONFLICT_STATUSES);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;

export const MemoryEntrySchema = z
  .object({
    /** Assigned by the store on write; absent on a proposal. */
    id: z.number().int().positive().optional(),
    type: MemoryTypeSchema,
    /** Absent for project-level memory that belongs to no single item. */
    work_item_id: WorkItemIdSchema.optional(),
    /**
     * The subject this entry makes a claim about.
     *
     * Load-bearing rather than decorative: conflict detection groups on it, so
     * two entries about "the CSV delimiter" can be found to disagree while two
     * unrelated observations are left alone. Required for that reason.
     */
    title: z.string().min(1),
    body: z.string().min(1),
    source_type: MemorySourceSchema,
    /** Agent or skill name plus run id — who wrote this, concretely. */
    written_by: z.string().min(1),
    /**
     * Salience at write time, assigned once (ADR-0023).
     *
     * Explicitly noisy: it is model-judged, nothing validates it across agents,
     * and every agent is inclined to rate its own conclusions as important. It
     * is one weighted term in the read-time score, never a gate.
     */
    importance: z.number().min(0).max(1).default(0.5),
    valid_from: z.iso.datetime(),
    /** `null` means currently believed. A close, never a delete. */
    valid_to: z.iso.datetime().nullable().default(null),
    superseded_by: z.number().int().positive().nullable().default(null),
    conflict_status: ConflictStatusSchema.default('none'),
    last_accessed_at: z.iso.datetime().nullable().default(null),
    content_hash: z.string().min(1),
  })
  .strict();

export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/** Whether an entry is currently believed. */
export function isCurrent(entry: MemoryEntry, at: Date = new Date()): boolean {
  if (entry.conflict_status === 'superseded') return false;
  if (entry.valid_to === null) return true;
  return Date.parse(entry.valid_to) > at.getTime();
}

/** Two entries make claims about the same subject when they share item, type and title. */
export function sameSubject(a: MemoryEntry, b: MemoryEntry): boolean {
  return (
    a.type === b.type &&
    (a.work_item_id ?? null) === (b.work_item_id ?? null) &&
    a.title.trim().toLowerCase() === b.title.trim().toLowerCase()
  );
}

export interface ConflictResolution {
  /** Entries whose validity window this write closes, with the reason. */
  readonly supersedes: readonly { readonly id: number; readonly validTo: string }[];
  /** Entries that disagree but cannot be ordered — both are flagged, neither wins. */
  readonly contested: readonly number[];
  /** True when an identical claim already exists; the write is a no-op. */
  readonly duplicate: boolean;
  readonly status: ConflictStatus;
}

/**
 * Decides what an incoming entry does to what is already believed.
 *
 * **This is the deterministic disposer** (ADR-0040 applied to ADR-0023): a model
 * may propose the extraction, but nothing here consults one. Same subject, same
 * content is a duplicate; same subject, different content, later validity is a
 * supersession; same subject, different content, *not* later is contested.
 *
 * The last case is the one worth defending. A fact recorded today can be about
 * last month — that is what bi-temporality is for — so "most recent write wins"
 * silently discards the older, possibly better-founded claim. ADR-0023 names
 * exactly that as the common and serious failure mode. When the entries cannot
 * be ordered, both are marked contested and a human decides; a rule that always
 * produced an answer here would be a guess with better posture.
 */
export function resolveConflicts(
  incoming: MemoryEntry,
  existing: readonly MemoryEntry[],
  at: Date = new Date(),
): ConflictResolution {
  const rivals = existing.filter(
    (entry) => entry.id !== undefined && sameSubject(entry, incoming) && isCurrent(entry, at),
  );

  if (rivals.some((entry) => entry.content_hash === incoming.content_hash)) {
    // Re-asserting a belief is not a correction. Recording it again would grow
    // the store without adding anything, which is the accumulation failure.
    return { supersedes: [], contested: [], duplicate: true, status: 'none' };
  }

  const supersedes: { id: number; validTo: string }[] = [];
  const contested: number[] = [];

  for (const rival of rivals) {
    if (rival.id === undefined) continue;
    if (Date.parse(incoming.valid_from) > Date.parse(rival.valid_from)) {
      // The old belief is closed at the moment the new one becomes true, not at
      // "now" — so the two windows abut rather than overlap, and a reader asking
      // "what did we believe on date X" gets exactly one answer.
      supersedes.push({ id: rival.id, validTo: incoming.valid_from });
    } else {
      contested.push(rival.id);
    }
  }

  return {
    supersedes,
    contested,
    duplicate: false,
    status: contested.length > 0 ? 'contested' : 'none',
  };
}

/** Weights for the read-time score (ADR-0023). Tunable, but not per-call. */
export interface RankingWeights {
  readonly recency: number;
  readonly relevance: number;
  readonly salience: number;
  /** Decay rate per day for the recency term. */
  readonly gamma: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  recency: 0.3,
  relevance: 0.5,
  salience: 0.2,
  gamma: 0.05,
};

/**
 * Read-time ranking: `w_recency·exp(-γ·Δt) + w_relevance·sim + w_salience·importance`.
 *
 * A formula over stored columns, not a model call — the same reason the gate
 * evaluates evidence rather than asking. Two callers ranking the same rows at
 * the same instant get the same order.
 *
 * `similarity` is injected because v0.1 has no embedding retrieval on this path.
 * Passing 0 is honest — the relevance term contributes nothing rather than being
 * quietly imputed from something it is not.
 */
export function scoreMemory(
  entry: MemoryEntry,
  similarity: number,
  at: Date = new Date(),
  weights: RankingWeights = DEFAULT_RANKING_WEIGHTS,
): number {
  const lastTouched = Date.parse(entry.last_accessed_at ?? entry.valid_from);
  const days = Math.max(0, (at.getTime() - lastTouched) / 86_400_000);
  return (
    weights.recency * Math.exp(-weights.gamma * days) +
    weights.relevance * similarity +
    weights.salience * entry.importance
  );
}

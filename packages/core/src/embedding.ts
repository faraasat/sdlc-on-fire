import { z } from 'zod';

/**
 * Local embeddings: the port, the model pin, and freshness (P1-CTX-04,
 * ADR-0004, contracts/05 §5.2).
 *
 * Two failure modes shape everything here, and neither is about model quality.
 *
 * **A corpus that mixes embedding spaces is silently wrong.** Vectors from two
 * models are not comparable — cosine distance between them is a number with no
 * meaning — so a corpus half-re-embedded after a model swap returns confident
 * nonsense, and nothing errors. So `model` is on every row, and a query whose
 * configured model disagrees with the corpus **skips the semantic leg entirely**
 * rather than querying across the seam. That is the contract's explicit
 * obligation: fail closed to lexical.
 *
 * **Re-embedding everything on every sync is the cost that kills the feature.**
 * Freshness is content-hash driven, and the hash is the *chunk's*, not the
 * file's — a one-line edit to a large document should not re-embed the document.
 *
 * The A-03 eval (2026-08-10) settled the model question: `bge-small-en-v1.5`
 * stays the default at 3× the lexical baseline on recall@1. It also found a
 * code-specialised model meaningfully better and meaningfully bigger, which is
 * exactly why the model is a config string and not a constant.
 */

/** The default local model. Config, not a constant — see the module note. */
export const DEFAULT_EMBEDDING_MODEL = 'bge-small-en-v1.5';

/** The column is `vector(384)`; a model of another width needs a migration. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

export const EmbeddingModelSchema = z
  .object({
    /** Stored on every row, so a corpus can always say what produced it. */
    id: z.string().min(1),
    dimensions: z.number().int().positive(),
  })
  .strict();

export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;

/**
 * What produces vectors.
 *
 * A port (ADR-0047): core defines it, adapters implement it, and nothing here
 * learns that ONNX exists. It also keeps the A-03 decision reversible — moving
 * to a code-specialised model is an adapter and a re-embed, not a rewrite.
 */
export interface EmbedderPort {
  readonly model: EmbeddingModel;
  /** Batch, because per-chunk inference over a whole corpus is the slow path. */
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/** A chunk as the corpus currently holds it, for the freshness comparison. */
export interface StoredVector {
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly index: number;
  readonly contentHash: string;
  readonly model: string;
  readonly tombstoned: boolean;
}

/** A chunk as it exists now, from the content. */
export interface LiveChunk {
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly index: number;
  readonly text: string;
  readonly contentHash: string;
}

export interface EmbeddingPlan {
  /** Chunks needing a vector: new, changed, or embedded by another model. */
  readonly embed: readonly LiveChunk[];
  /** Vectors whose chunk no longer exists — soft-deleted, never hard-deleted. */
  readonly tombstone: readonly StoredVector[];
  /** Tombstoned rows whose chunk came back unchanged; revived, not re-embedded. */
  readonly revive: readonly StoredVector[];
  /** Unchanged and current. Reported so "we did nothing" is visible, not inferred. */
  readonly unchanged: number;
  /**
   * True when the corpus holds live vectors from a model other than the active
   * one. The caller must read this as "the semantic leg is not usable yet",
   * never as a warning to note and continue past.
   */
  readonly mixedModel: boolean;
}

function keyOf(v: { sourceTable: string; sourceId: string; index: number }): string {
  return `${v.sourceTable} ${v.sourceId} ${String(v.index)}`;
}

/**
 * Decides what to embed, tombstone, or leave alone.
 *
 * Pure, so the decision is testable without a model or a database — and so a
 * caller can show a plan before spending inference on it.
 *
 * Tombstone rather than delete: a vector whose source vanished may be a genuine
 * deletion, or a file passing through an intermediate state during a sync.
 * Deleting on the second loses work a revive recovers for nothing.
 */
export function planEmbedding(
  live: readonly LiveChunk[],
  stored: readonly StoredVector[],
  activeModel: string,
): EmbeddingPlan {
  const storedByKey = new Map(stored.map((v) => [keyOf(v), v]));
  const liveKeys = new Set(live.map(keyOf));

  const embed: LiveChunk[] = [];
  const revive: StoredVector[] = [];
  let unchanged = 0;

  for (const chunk of live) {
    const existing = storedByKey.get(keyOf(chunk));
    if (existing === undefined) {
      embed.push(chunk);
      continue;
    }
    // A different model is as stale as different text. Comparing vectors across
    // embedding spaces produces a number, and the number means nothing.
    if (existing.model !== activeModel || existing.contentHash !== chunk.contentHash) {
      embed.push(chunk);
      continue;
    }
    if (existing.tombstoned) revive.push(existing);
    else unchanged += 1;
  }

  const tombstone = stored.filter((v) => !v.tombstoned && !liveKeys.has(keyOf(v)));

  return {
    embed,
    tombstone,
    revive,
    unchanged,
    mixedModel: stored.some((v) => !v.tombstoned && v.model !== activeModel),
  };
}

export type SemanticLegDecision =
  { readonly usable: true } | { readonly usable: false; readonly reason: string };

/**
 * Whether the semantic leg may run for this query (contracts/05 §5.2).
 *
 * The contract's word is "fail closed": when the configured model does not match
 * what the corpus holds, the leg is **skipped** and retrieval falls back to
 * lexical. It does not query anyway and attach a caveat — a caller cannot act on
 * a caveat, and a mixed-space result is not a degraded answer but a meaningless
 * one.
 */
export function semanticLegUsable(input: {
  readonly configuredModel: string;
  readonly corpusModels: readonly string[];
  readonly vectorsPresent: number;
}): SemanticLegDecision {
  if (input.vectorsPresent === 0) {
    return { usable: false, reason: 'no vectors have been written yet' };
  }
  const foreign = [...new Set(input.corpusModels)].filter(
    (model) => model !== input.configuredModel,
  );
  if (foreign.length > 0) {
    return {
      usable: false,
      reason:
        `the corpus holds vectors from ${foreign.join(', ')} but this workspace is configured for ` +
        `${input.configuredModel} — cosine distance across two embedding spaces is a number with ` +
        'no meaning, so the semantic leg is skipped until a full re-embed completes',
    };
  }
  return { usable: true };
}

/** Cosine similarity over L2-normalised vectors. A dot product, named for what it means. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cannot compare a ${String(a.length)}-dim vector with a ${String(b.length)}-dim one — ` +
        'this is the mixed-embedding-space bug, caught at the comparison rather than ' +
        'returned as a score',
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

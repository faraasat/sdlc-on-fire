/**
 * The optional cross-encoder reranker (P1-CTX-09, FEAT-CTX-023, contracts/05
 * §3.3 item 5).
 *
 * Fusion orders documents without ever comparing a query to a document
 * *together*: the lexical leg scores term overlap, the semantic leg scores two
 * independently-produced vectors. A cross-encoder reads the pair in one forward
 * pass, which is why it is more accurate and why it costs more — there is no
 * index to precompute, so it runs at query time over every candidate.
 *
 * That cost is the whole design constraint:
 *
 * - **Optional, and off by default.** A second local model is a second
 *   download, a second warm-up, and per-query latency on the interactive path.
 *   A workspace opts in.
 * - **It reorders, it never admits.** The reranker only ever sees what fusion
 *   already retrieved, so it cannot rescue a document neither leg found. Anyone
 *   reading a rerank stage as "the model picks the best chunks" has the shape
 *   wrong, and would size the fusion prefetch accordingly.
 * - **A failure degrades to the fused order.** An unavailable model, a timeout,
 *   a crash — the pipeline returns fusion's ranking rather than nothing. A
 *   reranker that can take retrieval down with it is a worse trade than not
 *   having one.
 */

import {
  hybridSearch,
  type HybridHit,
  type HybridOptions,
  type HybridResult,
  type HybridStore,
} from './hybrid.js';

/** Scores a (query, document) pair. Higher is more relevant. */
export type CrossEncoder = (
  query: string,
  documents: readonly string[],
) => Promise<readonly number[]>;

export interface RerankOptions {
  /** How many of the fused hits to rerank. Beyond this, fusion's order stands. */
  readonly topK?: number | undefined;
  /** Skipped entirely at `effort: low` (.research/04 §4). */
  readonly enabled?: boolean | undefined;
}

export interface RerankResult {
  readonly hits: readonly HybridHit[];
  readonly reranked: boolean;
  /** Why it did not run, when it did not. Never silent. */
  readonly skipped?: string | undefined;
  /** How many pairs were actually scored, so the cost is visible. */
  readonly scored: number;
}

/** Default depth. Reranking more than this costs more than the ordering is worth. */
export const DEFAULT_RERANK_TOP_K = 20;

/**
 * Reorders fused hits by cross-encoder score.
 *
 * Only the first `topK` are rescored; the tail keeps fusion's order and is
 * appended below. Rescoring everything would make the reranker's cost scale
 * with the prefetch depth, which is exactly the knob you want to raise for
 * recall.
 */
export async function rerank(
  query: string,
  hits: readonly HybridHit[],
  encoder: CrossEncoder | undefined,
  options: RerankOptions = {},
): Promise<RerankResult> {
  if (options.enabled === false) {
    return { hits, reranked: false, skipped: 'reranking disabled for this assembly', scored: 0 };
  }
  if (encoder === undefined) {
    return { hits, reranked: false, skipped: 'no cross-encoder configured', scored: 0 };
  }
  if (hits.length === 0) {
    // Nothing to reorder. Reported as not-reranked rather than as a successful
    // rerank of nothing, because the two mean different things to a caller
    // deciding whether its retrieval is healthy.
    return { hits, reranked: false, skipped: 'no candidates to rerank', scored: 0 };
  }

  const topK = options.topK ?? DEFAULT_RERANK_TOP_K;
  const head = hits.slice(0, topK);
  const tail = hits.slice(topK);

  let scores: readonly number[];
  try {
    scores = await encoder(
      query,
      head.map((hit) => hit.text),
    );
  } catch (cause) {
    // Degrade to the fused order. A reranker that can take retrieval down with
    // it is a worse trade than not having one.
    return {
      hits,
      reranked: false,
      skipped: `cross-encoder failed, falling back to the fused order: ${String(cause)}`,
      scored: 0,
    };
  }

  if (scores.length !== head.length) {
    return {
      hits,
      reranked: false,
      // Misaligned scores would reorder documents by another document's
      // relevance — worse than not reranking, and invisible in the output.
      skipped: `cross-encoder returned ${String(scores.length)} scores for ${String(head.length)} documents`,
      scored: 0,
    };
  }

  const reordered = head
    .map((hit, i) => ({ hit, score: scores[i] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.score - a.score || a.hit.id.localeCompare(b.hit.id))
    .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 1e6) / 1e6 }));

  return { hits: [...reordered, ...tail], reranked: true, scored: head.length };
}

export interface RetrieveOptions extends HybridOptions, RerankOptions {
  /** Absent means no rerank stage, deliberately — the default for a workspace. */
  readonly encoder?: CrossEncoder | undefined;
}

export type RetrieveResult = HybridResult & Omit<RerankResult, 'hits'>;

/**
 * The retrieval pipeline: fuse, then optionally rerank (contracts/05 §3.3).
 *
 * The reranker sits *after* the fusion truncates to `limit`, not between the
 * prefetch and the truncation. Reranking the full prefetch would score
 * `prefetch × legs` pairs per query to reorder a list most of which is discarded
 * — the reranker's cost would then scale with the recall knob.
 *
 * Every skip reason from both stages survives to the caller. A pipeline that
 * quietly ran lexical-only and quietly skipped the rerank looks identical to a
 * healthy one from the outside, and that is how a degraded index goes unnoticed
 * for a week.
 */
export async function retrieve(
  db: HybridStore,
  queryText: string,
  options: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const fused = await hybridSearch(db, queryText, options);
  const { hits, ...rerankInfo } = await rerank(queryText, fused.hits, options.encoder, options);
  return { ...fused, ...rerankInfo, hits };
}

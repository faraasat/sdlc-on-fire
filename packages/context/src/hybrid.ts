import { semanticLegUsable, type EmbedderPort } from '@sdlc-on-fire/core';
import { toSearchQuery } from './retrieval.js';

/**
 * Hybrid retrieval: lexical + semantic, fused by RRF (P1-CTX-03, contracts/05
 * §3.3).
 *
 * The two legs fail differently, which is the entire argument for running both.
 * Lexical finds an exact identifier and misses a paraphrase; semantic finds the
 * paraphrase and drifts on a rare token it never learned. The A-03 eval measured
 * both on this repo — lexical recall@1 0.086, semantic 0.256 — and the
 * interesting number is not that semantic won but that lexical found things
 * semantic did not.
 *
 * **Reciprocal Rank Fusion, not score blending.** The two legs produce numbers
 * that are not on the same scale and never will be: `ts_rank_cd` is unbounded
 * and corpus-dependent, cosine is [-1, 1]. Normalising them into a weighted sum
 * requires a per-corpus calibration nobody will maintain, and a stale one
 * silently reweights every query. RRF discards the scores and uses only rank,
 * which is the one thing both legs agree on the meaning of.
 *
 * **The semantic leg fails closed.** If the corpus and the configured model
 * disagree, the leg is skipped and the result is lexical-only — reported as
 * such, so a caller can tell "retrieval is degraded" from "there is nothing to
 * find" (contracts/05 §5.2).
 */

/** `.research/04 §2`'s common starting default. Unvalidated on this corpus; see below. */
export const DEFAULT_RRF_K = 60;
export const DEFAULT_PREFETCH = 20;

export interface HybridStore {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface HybridHit {
  readonly id: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly index: number;
  readonly text: string;
  readonly score: number;
  /** Which legs found it, so a degraded result is visible rather than inferred. */
  readonly legs: readonly ('lexical' | 'semantic')[];
}

export interface HybridResult {
  readonly hits: readonly HybridHit[];
  readonly lexicalRan: boolean;
  readonly semanticRan: boolean;
  /** Why the semantic leg was skipped, when it was. */
  readonly semanticSkipped?: string | undefined;
}

export interface HybridOptions {
  readonly limit?: number | undefined;
  readonly prefetch?: number | undefined;
  readonly rrfK?: number | undefined;
  /** Absent means lexical-only, deliberately — not "semantic with no model". */
  readonly embedder?: EmbedderPort | undefined;
}

interface Row {
  source_table: string;
  source_id: string;
  chunk_index: number;
  chunk_text: string;
}

const idOf = (row: Row): string =>
  `${row.source_table} ${row.source_id} ${String(row.chunk_index)}`;

/**
 * Reciprocal Rank Fusion.
 *
 * `1/(k + rank)`, summed across legs. `k` flattens the curve so a rank-1 hit
 * from one leg does not automatically outrank a document both legs agreed on at
 * rank 3 — which is the property that makes fusion worth doing rather than just
 * concatenating.
 *
 * Exported because the constant is a *carried-over default* (`.research/04`),
 * not a number validated against this corpus. contracts/05 says as much. A
 * caller tuning it should be able to, and the A-03 harness is the thing that
 * would justify a different value.
 */
export function rrf(rank: number, k: number = DEFAULT_RRF_K): number {
  return 1 / (k + rank);
}

/**
 * Runs both legs and fuses them.
 *
 * Each leg is queried independently and to its own prefetch depth. Fusing after
 * truncation rather than before would mean a document ranked 21st lexically and
 * 1st semantically never reaches the fusion at all — which is exactly the
 * document hybrid retrieval exists to surface.
 */
export async function hybridSearch(
  db: HybridStore,
  queryText: string,
  options: HybridOptions = {},
): Promise<HybridResult> {
  const limit = options.limit ?? 10;
  const prefetch = options.prefetch ?? DEFAULT_PREFETCH;
  const k = options.rrfK ?? DEFAULT_RRF_K;

  const ranks = new Map<string, { row: Row; legs: Set<'lexical' | 'semantic'>; score: number }>();
  const add = (row: Row, rank: number, leg: 'lexical' | 'semantic'): void => {
    const id = idOf(row);
    const entry = ranks.get(id) ?? { row, legs: new Set<'lexical' | 'semantic'>(), score: 0 };
    entry.legs.add(leg);
    entry.score += rrf(rank, k);
    ranks.set(id, entry);
  };

  const lexical = await db.query<Row>(
    `SELECT source_table, source_id, chunk_index, chunk_text
       FROM embeddings
      WHERE chunk_tsv @@ to_tsquery('english', $1)
        AND tombstoned_at IS NULL
      ORDER BY ts_rank_cd(chunk_tsv, to_tsquery('english', $1)) DESC
      LIMIT $2;`,
    [toSearchQuery(queryText), prefetch],
  );
  lexical.forEach((row, i) => {
    add(row, i + 1, 'lexical');
  });

  let semanticRan = false;
  let semanticSkipped: string | undefined;

  if (options.embedder === undefined) {
    semanticSkipped = 'no embedder configured — lexical only';
  } else {
    const state = await db.query<{ model: string; n: string }>(
      `SELECT model, count(*)::text AS n FROM embeddings
        WHERE tombstoned_at IS NULL AND embedding IS NOT NULL GROUP BY model;`,
    );
    const decision = semanticLegUsable({
      configuredModel: options.embedder.model.id,
      corpusModels: state.map((row) => row.model),
      vectorsPresent: state.reduce((sum, row) => sum + Number(row.n), 0),
    });

    if (!decision.usable) {
      semanticSkipped = decision.reason;
    } else {
      const [vector] = await options.embedder.embed([queryText]);
      const semantic = await db.query<Row>(
        `SELECT source_table, source_id, chunk_index, chunk_text
           FROM embeddings
          WHERE tombstoned_at IS NULL AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2;`,
        [`[${Array.from(vector ?? new Float32Array()).join(',')}]`, prefetch],
      );
      semantic.forEach((row, i) => {
        add(row, i + 1, 'semantic');
      });
      semanticRan = true;
    }
  }

  const hits = [...ranks.values()]
    .sort((a, b) => b.score - a.score || idOf(a.row).localeCompare(idOf(b.row)))
    .slice(0, limit)
    .map((entry) => ({
      id: idOf(entry.row),
      sourceTable: entry.row.source_table,
      sourceId: entry.row.source_id,
      index: Number(entry.row.chunk_index),
      text: entry.row.chunk_text,
      score: Math.round(entry.score * 1e6) / 1e6,
      legs: [...entry.legs].sort(),
    }));

  return {
    hits,
    lexicalRan: true,
    semanticRan,
    ...(semanticSkipped === undefined ? {} : { semanticSkipped }),
  };
}

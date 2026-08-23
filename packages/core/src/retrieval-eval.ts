import { z } from 'zod';

/**
 * Retrieval precision@k (P6-INSTRUMENT-01, FEAT-MET-012).
 *
 * **The number that decides whether the context engine works.** Everything else
 * in the retrieval stack — hybrid fusion, the RRF constant, reranking, chunk
 * size — is tuning against an unmeasured target until this exists. `rrf`'s own
 * comment says `DEFAULT_RRF_K = 60` is "unvalidated on this corpus"; that
 * sentence has been true because there was nothing to validate against.
 *
 * **Judgements are authored by a person, never by a model.** A relevance set
 * labelled by the same class of model being evaluated measures agreement
 * between two runs of the same system, and it produces a high score for exactly
 * the retrievals a human would call wrong. The schema records who judged, and
 * `judged_by` has no default: a judgement with no author cannot be argued with
 * later, which is the property that makes the set worth keeping.
 *
 * **Precision@k has a ceiling, and it is reported.** A query with three relevant
 * chunks can never exceed 0.3 at k=10 — the metric is capped by the corpus, not
 * by the retriever. Printing that 0.3 beside a target of 0.8 makes a perfect
 * retriever look broken, which is how a measurement gets argued away rather than
 * acted on.
 */

export const RelevanceJudgementSchema = z
  .strictObject({
    /** The query, as a user would actually phrase it. */
    query: z.string().min(1),
    /**
     * Chunk ids that answer it, in no particular order.
     *
     * Ids, not text. A judgement stored as prose has to be re-matched against
     * the corpus every run, and a fuzzy match is a second retrieval problem
     * sitting inside the evaluation of the first.
     */
    relevant: z.array(z.string().min(1)).min(1),
    /** Who judged. No default — an unattributable judgement cannot be argued with. */
    judged_by: z.string().min(1),
    judged_on: z.iso.date(),
    /** Why these and not others. The half that makes a disagreement productive. */
    because: z.string().min(1).optional(),
  })
  .describe('one human relevance judgement');
export type RelevanceJudgement = z.infer<typeof RelevanceJudgementSchema>;

export const RelevanceSetSchema = z.strictObject({
  schema_version: z.string().min(1),
  /**
   * Held out from tuning. Stated in the file, because the discipline is only
   * real if breaking it requires editing a line that says so (P7-HELDOUT-01).
   */
  held_out: z.literal(true),
  judgements: z.array(RelevanceJudgementSchema).min(1),
});
export type RelevanceSet = z.infer<typeof RelevanceSetSchema>;

export interface QueryScore {
  readonly query: string;
  readonly k: number;
  readonly retrieved: number;
  readonly relevant: number;
  readonly hits: number;
  /** `hits / k`. Capped by the corpus when fewer than k chunks are relevant. */
  readonly precision: number;
  /**
   * The best precision this query could possibly score: `min(relevant, k) / k`.
   *
   * Reported beside `precision` so a query with two relevant chunks at k=10 is
   * not read as a retriever failing at 0.2.
   */
  readonly ceiling: number;
  /** `precision / ceiling` — how much of what was achievable was achieved. */
  readonly ofCeiling: number | null;
  /** `hits / relevant`. The half precision cannot see: what was missed. */
  readonly recall: number;
  /** Relevant chunks the retriever never returned. The actionable list. */
  readonly missed: readonly string[];
}

export interface RetrievalEvaluation {
  readonly k: number;
  readonly queries: readonly QueryScore[];
  /** Mean precision across queries, or `null` with no queries. */
  readonly meanPrecision: number | null;
  readonly meanOfCeiling: number | null;
  readonly meanRecall: number | null;
  /** Queries where nothing relevant was returned at all. The list to fix first. */
  readonly blind: readonly string[];
}

/**
 * Scores one query's retrieved ids against its judgement.
 *
 * `retrieved` must already be truncated to k by the caller and in rank order —
 * truncating here would hide a retriever that returned fewer than k results,
 * and "returned 3 of 10 and got all 3 right" is a different situation from
 * "returned 10 and got 3 right".
 */
export function scoreQuery(
  judgement: RelevanceJudgement,
  retrieved: readonly string[],
  k: number,
): QueryScore {
  const relevant = new Set(judgement.relevant);
  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  const ceiling = Math.min(relevant.size, k) / k;

  return {
    query: judgement.query,
    k,
    retrieved: topK.length,
    relevant: relevant.size,
    hits,
    // Divided by k, not by what was returned. A retriever that returns two
    // results and gets both right has not achieved precision 1.0 at k=10 — it
    // has failed to fill the slots, and dividing by `topK.length` would report
    // that as perfect.
    precision: hits / k,
    ceiling,
    ofCeiling: ceiling === 0 ? null : hits / k / ceiling,
    recall: hits / relevant.size,
    missed: judgement.relevant.filter((id) => !topK.includes(id)),
  };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, v) => total + v, 0) / values.length;
}

export function evaluateRetrieval(scores: readonly QueryScore[], k: number): RetrievalEvaluation {
  return {
    k,
    queries: scores,
    meanPrecision: mean(scores.map((score) => score.precision)),
    meanOfCeiling: mean(
      scores.map((score) => score.ofCeiling).filter((value): value is number => value !== null),
    ),
    meanRecall: mean(scores.map((score) => score.recall)),
    // Listed by name rather than counted. A mean hides the query that returns
    // nothing useful at all, and that query is the one worth reading.
    blind: scores.filter((score) => score.hits === 0).map((score) => score.query),
  };
}

import type { HybridHit } from './hybrid.js';

/**
 * Corrective-RAG evaluation of retrieval results (P2-CTX-01, FEAT-CTX-022).
 *
 * CRAG's shape: before retrieved context goes into a pack, judge whether it
 * actually answers the query. `Correct` inserts it, `Incorrect` triggers a
 * requery, `Ambiguous` inserts it flagged as low-confidence. Without this a
 * retrieval that found nothing relevant is indistinguishable from one that
 * found exactly the right thing — both hand back a list.
 *
 * **The tension with ADR-0040, and how it is resolved.** CRAG as published uses
 * a prompted LLM evaluator, and this product's rule is that a decision path
 * needs a deterministic disposer. Both hold here, by splitting the decision:
 *
 * 1. **Deterministic signals decide what they can.** No hits is `incorrect`
 *    without asking anyone. A top score below the floor is `incorrect`. A
 *    strong top score with a clear margin over the runner-up is `correct`.
 *    These are the cases where a model's opinion would add latency and
 *    variance to a conclusion already available.
 * 2. **The model is consulted only in the middle** — plausible scores, no clear
 *    separation — which is where a judgement genuinely is required.
 * 3. **What happens per verdict is fixed policy, not the model's choice.** The
 *    evaluator classifies; it never decides to skip a requery or to drop the
 *    low-confidence flag. The one thing a model could get wrong that would
 *    matter — quietly upgrading weak context to trusted — is not a thing it is
 *    asked.
 *
 * **The evaluator fails toward `ambiguous`, never `correct`.** A model that
 * errors, times out, or answers unintelligibly leaves the retrieval flagged
 * rather than trusted. Same shape as every other adapter here: not reaching an
 * answer is not the same as the answer being fine.
 */

export type CorrectiveVerdict = 'correct' | 'incorrect' | 'ambiguous';

/** What the pipeline does about it. Fixed per verdict, never model-chosen. */
export type CorrectiveAction = 'insert' | 'requery' | 'insert-flagged';

export interface CorrectiveResult {
  readonly verdict: CorrectiveVerdict;
  readonly action: CorrectiveAction;
  /** Which layer concluded, so the cost and the confidence are both legible. */
  readonly decidedBy: 'deterministic' | 'evaluator' | 'evaluator-unavailable';
  readonly reason: string;
  /** Set when the verdict is `incorrect`, so a caller knows what to try next. */
  readonly requery?: string | undefined;
}

/**
 * The prompted evaluator (CRAG's own component), as a port.
 *
 * Returns a verdict or `null` for "could not decide". `null` is a first-class
 * answer rather than an error, because a model saying so is more useful than a
 * model guessing.
 */
export type RetrievalEvaluator = (input: {
  readonly query: string;
  readonly passages: readonly string[];
}) => Promise<CorrectiveVerdict | null>;

export interface CorrectiveOptions {
  readonly evaluator?: RetrievalEvaluator | undefined;
  /**
   * At `low`, the evaluator is skipped and only the deterministic signals run.
   * The middle band then resolves to `ambiguous` — flagged, not discarded,
   * because a cheap tier should cost less, not silently trust more.
   */
  readonly effort?: 'low' | 'max' | undefined;
  /** How many passages the evaluator sees. Beyond this, more is noise. */
  readonly sampleSize?: number | undefined;
}

/**
 * Score thresholds.
 *
 * Named rather than inlined for the same reason `RISK_THRESHOLDS` is: they are
 * starting values tuned against nothing, and the first real usage data should
 * move them. A number buried in a conditional is a number nobody revisits.
 */
export const CORRECTIVE_THRESHOLDS = {
  /** Below this, the best hit is not plausibly relevant. */
  scoreFloor: 0.15,
  /** At or above this, the best hit is relevant enough not to need an opinion. */
  scoreCeiling: 0.75,
  /** How far the top hit must lead the runner-up to count as a clear answer. */
  margin: 0.2,
} as const;

const DEFAULT_SAMPLE = 5;

/**
 * A broader query to try when retrieval came back wrong.
 *
 * Deliberately mechanical: strip the quoted phrases and the rarest-looking
 * tokens that likely over-constrained the search. A model-written requery would
 * be better and is not available here — the evaluator port answers verdicts,
 * not queries, and adding a second model call to fix the first is how a
 * retrieval path becomes slower than the work it feeds.
 */
export function broadenQuery(query: string): string {
  const withoutQuotes = query.replaceAll(/["'`][^"'`]*["'`]/g, ' ');
  const tokens = withoutQuotes
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => token.length > 2)
    .filter((token) => !/^\d+$/.test(token));

  // Keep the longest tokens: in a code search those are the identifiers, and
  // the short ones are the glue that matched everything.
  const kept = [...tokens].sort((a, b) => b.length - a.length).slice(0, 6);
  // Restored to the order they appeared in, so the requery reads like a query
  // rather than a bag of words.
  const ordered = tokens.filter((token) => kept.includes(token));
  return [...new Set(ordered)].join(' ').trim() || query.trim();
}

const ACTION: Readonly<Record<CorrectiveVerdict, CorrectiveAction>> = {
  correct: 'insert',
  incorrect: 'requery',
  ambiguous: 'insert-flagged',
};

export async function evaluateRetrieval(
  query: string,
  hits: readonly HybridHit[],
  options: CorrectiveOptions = {},
): Promise<CorrectiveResult> {
  const decide = (
    verdict: CorrectiveVerdict,
    decidedBy: CorrectiveResult['decidedBy'],
    reason: string,
  ): CorrectiveResult => ({
    verdict,
    action: ACTION[verdict],
    decidedBy,
    reason,
    ...(verdict === 'incorrect' ? { requery: broadenQuery(query) } : {}),
  });

  if (hits.length === 0) {
    return decide('incorrect', 'deterministic', 'retrieval returned nothing');
  }

  const top = hits[0]?.score ?? 0;
  const runnerUp = hits[1]?.score ?? 0;

  if (top < CORRECTIVE_THRESHOLDS.scoreFloor) {
    return decide(
      'incorrect',
      'deterministic',
      `best hit scored ${top.toFixed(3)}, below the ${String(CORRECTIVE_THRESHOLDS.scoreFloor)} floor`,
    );
  }

  if (top >= CORRECTIVE_THRESHOLDS.scoreCeiling && top - runnerUp >= CORRECTIVE_THRESHOLDS.margin) {
    return decide(
      'correct',
      'deterministic',
      `best hit scored ${top.toFixed(3)} and leads the runner-up by ${(top - runnerUp).toFixed(3)}`,
    );
  }

  // The middle band. This is the case CRAG's evaluator exists for.
  if (options.effort === 'low' || options.evaluator === undefined) {
    return decide(
      'ambiguous',
      'evaluator-unavailable',
      options.effort === 'low'
        ? 'scores are inconclusive and the evaluator is skipped at low effort'
        : 'scores are inconclusive and no evaluator is configured',
    );
  }

  const passages = hits.slice(0, options.sampleSize ?? DEFAULT_SAMPLE).map((hit) => hit.text);

  let verdict: CorrectiveVerdict | null;
  try {
    verdict = await options.evaluator({ query, passages });
  } catch {
    // Failing toward `correct` would let an outage insert weak context as
    // trusted, which is the one outcome nothing downstream can detect.
    return decide('ambiguous', 'evaluator-unavailable', 'the evaluator failed');
  }

  if (verdict === null) {
    return decide('ambiguous', 'evaluator', 'the evaluator declined to conclude');
  }

  return decide(verdict, 'evaluator', `the evaluator judged the passages ${verdict}`);
}

export function formatCorrective(result: CorrectiveResult): string {
  const lines = [`${result.verdict} (${result.decidedBy}) — ${result.reason}`];
  if (result.action === 'requery' && result.requery !== undefined) {
    lines.push(`  retry with: ${result.requery}`);
  }
  if (result.action === 'insert-flagged') {
    lines.push('  inserted, marked low-confidence in the pack metadata');
  }
  return lines.join('\n');
}

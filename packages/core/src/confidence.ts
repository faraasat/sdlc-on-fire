import type { Preset } from './lifecycle.js';

/**
 * Confidence-gated routing from harness-derived signals (P2-GATE-05, ADR-0025).
 *
 * The static `lite/standard/strict` preset decides rigor before a task starts.
 * This decides what to do when a *particular* task turns out harder than its
 * preset assumed — retry with more context, escalate a tier, or stop and ask a
 * person.
 *
 * **The signal is never the model's own account of itself.** ADR-0025 is
 * emphatic, and the 2026 research it cites is the reason: models produce
 * confidence numbers that look calibrated, fail to act on them without a
 * deterministic harness, and give badly discretized answers when asked to rate
 * themselves. Self-explanations do not even survive paraphrase. So
 * "rate yourself 0–100%" is not a signal this module accepts — and it is not
 * accepted *structurally*, not by convention: `ConfidenceSource` has three
 * members and none of them is `narrated`, so a caller cannot express it. Same
 * device as `actorKind: 'human'` on approvals; a rule you cannot type is a rule
 * nobody argues about at 6pm.
 *
 * **The boundary ADR-0025 left open, drawn.** Its consequences section flags
 * that the line between "adaptive confidence-gated routing" (adopted) and
 * "full self-modeling agent" (rejected) was not yet crisp. It is this: **this
 * module reads the harness's observations of outputs, never the model's
 * observations of itself.** Agreement across samples is something the harness
 * measures. Token probability is something the API reports. A rubric score is
 * something a deterministic checker computes. Anything requiring the model to
 * introspect — its certainty, its reasoning, its own competence — is on the far
 * side of that line and is not built here.
 *
 * **The spike finding, recorded rather than assumed.** Self-consistency costs
 * N× inference per gated decision, which is a strange thing to spend protecting
 * an effort budget. So sampling is not the default: it is available, its cost
 * is computable before it is paid, and `lite` cannot reach it at all. What this
 * repo has *not* got is calibration data — no measurement exists yet of how
 * well any of these signals predicts a failing gate on this product's own
 * tasks. The thresholds below are starting values, and they say so.
 */

/**
 * Where a confidence number may come from.
 *
 * Three sources, deliberately. Adding a fourth is a decision someone has to
 * make in this file, in a diff, rather than at a call site.
 */
export const CONFIDENCE_SOURCES = ['self-consistency', 'logprob', 'rubric'] as const;
export type ConfidenceSource = (typeof CONFIDENCE_SOURCES)[number];

export interface ConfidenceSignal {
  readonly source: ConfidenceSource;
  /** 0–1. What it means differs per source; what it decides does not. */
  readonly value: number;
  /** How many model calls produced it, so the cost of the signal is visible. */
  readonly samples: number;
}

export type ConfidenceRoute = 'proceed' | 'retry-with-context' | 'escalate-tier' | 'defer-to-human';

export interface RoutingDecision {
  readonly route: ConfidenceRoute;
  readonly reason: string;
  /** The signal that decided, or null when none was available. */
  readonly signal: ConfidenceSignal | null;
}

/**
 * Starting thresholds, not measurements.
 *
 * ADR-0025 notes calibration is model- and domain-dependent, and a 33-model
 * atlas found real cross-model variance. Named here so recalibration is one
 * edit against one place, and so nobody mistakes them for findings.
 */
export const CONFIDENCE_THRESHOLDS = {
  /** At or above: the task looks like what the tier expects. */
  proceed: 0.75,
  /** Below this, more context is unlikely to help — the tier is wrong. */
  escalate: 0.45,
  /** Below this, nothing automated should continue. */
  defer: 0.2,
} as const;

/**
 * Agreement across independently sampled answers.
 *
 * The harness measures whether the model said the same thing more than once. It
 * does not ask the model whether it meant it — which is the entire distinction
 * this module rests on.
 *
 * Normalisation is by the modal answer's share, so two samples agreeing out of
 * two reads as 1.0 and five different answers out of five as 0.2. A single
 * sample is 1.0 by arithmetic and carries no information, so it is refused
 * rather than reported: a confidence of 1.0 derived from asking once is the
 * most misleading number this function could return.
 */
export function selfConsistency(answers: readonly string[]): ConfidenceSignal | null {
  if (answers.length < 2) return null;

  const counts = new Map<string, number>();
  for (const answer of answers) {
    const key = answer.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const modal = Math.max(...counts.values());
  return {
    source: 'self-consistency',
    value: modal / answers.length,
    samples: answers.length,
  };
}

/**
 * A signal from token log-probabilities.
 *
 * The cheap default: one call, and the number comes from the API rather than
 * from the model's opinion. Mean per-token probability rather than sequence
 * probability, because the latter shrinks with length and would make every long
 * answer look uncertain.
 */
export function logprobConfidence(logprobs: readonly number[]): ConfidenceSignal | null {
  if (logprobs.length === 0) return null;
  const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;
  return { source: 'logprob', value: Math.min(1, Math.max(0, Math.exp(mean))), samples: 1 };
}

/**
 * A signal from a deterministic rubric.
 *
 * The checker scores the output against criteria it holds; the model does not
 * score itself. Available where the other two are not — a provider that exposes
 * no log-probabilities and a budget that will not pay for sampling.
 */
export function rubricConfidence(passed: number, total: number): ConfidenceSignal | null {
  if (total <= 0) return null;
  return { source: 'rubric', value: Math.min(1, Math.max(0, passed / total)), samples: 1 };
}

/** The cost of a self-consistency signal, in extra model calls. */
export function samplingCost(samples: number): number {
  return Math.max(0, samples - 1);
}

/**
 * Whether this preset may spend on self-consistency sampling.
 *
 * `lite` cannot. A team on `lite` asked for cheap, and N× inference to decide
 * whether to escalate is the opposite of that — the signal would cost more than
 * the escalation it is deciding about.
 */
export function maySampleFor(preset: Preset, maxSamples = 3): number {
  if (preset === 'lite') return 1;
  return preset === 'strict' ? maxSamples : Math.min(2, maxSamples);
}

/**
 * How much intervention each route represents. Ordered, so "at least this much"
 * is expressible.
 */
export const ROUTE_SEVERITY: Readonly<Record<ConfidenceRoute, number>> = {
  proceed: 0,
  'retry-with-context': 1,
  'escalate-tier': 2,
  'defer-to-human': 3,
};

/**
 * Why there is no per-preset floor clamping the route, despite ADR-0025's
 * "additive on top of, not a replacement for" requirement.
 *
 * The first version of this file had one — a `PRESET_FLOOR` table raising the
 * route to a per-preset minimum. Every entry was `proceed`, the lowest value,
 * so the clamp could never fire. Machinery that looks like a safety control and
 * is arithmetically incapable of acting is worse than no machinery: it answers
 * the question "what stops confidence lowering rigor?" with something reassuring
 * and inert.
 *
 * The real answer is structural and needs no table. **`ConfidenceRoute` has no
 * member that removes anything.** `proceed` means "continue with the stages the
 * preset already requires" — not "skip them" — and the other three only add
 * work. There is no value this function can return that shortens a `strict`
 * item's ladder, so a confidence signal cannot talk a preset out of its own
 * rigor no matter what it measures. That is the guarantee, and it holds because
 * the vocabulary is closed rather than because a comparison is performed.
 */

/**
 * What to do about a task, given what the harness measured.
 *
 * **No signal routes to `defer-to-human`, not to `proceed`.** A provider with
 * no log-probabilities, a budget that refused sampling, a rubric that could not
 * run — all of those mean nothing was measured, and reading "we did not measure"
 * as "it is fine" is the substitution this product refuses everywhere else. It
 * is also the failure that would be invisible: an unmeasured task proceeding
 * looks exactly like a confident one.
 */
export function routeOnConfidence(
  signal: ConfidenceSignal | null,
  _preset: Preset,
): RoutingDecision {
  if (signal === null) {
    return {
      route: 'defer-to-human',
      reason:
        'no confidence signal was available — nothing was measured, which is not the same as measuring that it is fine',
      signal: null,
    };
  }

  let route: ConfidenceRoute;
  if (signal.value >= CONFIDENCE_THRESHOLDS.proceed) route = 'proceed';
  else if (signal.value >= CONFIDENCE_THRESHOLDS.escalate) route = 'retry-with-context';
  else if (signal.value >= CONFIDENCE_THRESHOLDS.defer) route = 'escalate-tier';
  else route = 'defer-to-human';

  return {
    route,
    reason: `${signal.source} scored ${signal.value.toFixed(2)} across ${String(signal.samples)} sample(s)`,
    signal,
  };
}

export function formatRouting(decision: RoutingDecision, preset: Preset): string {
  const lines = [`${preset}: ${decision.route} — ${decision.reason}`];
  if (decision.signal !== null && decision.signal.samples > 1) {
    lines.push(
      `  cost: ${String(samplingCost(decision.signal.samples))} extra model call(s) to produce this signal`,
    );
  }
  if (decision.route === 'defer-to-human') {
    lines.push('  a person decides; nothing automated continues from here');
  }
  return lines.join('\n');
}

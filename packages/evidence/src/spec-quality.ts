import { isScoredCriterion, type ReadinessInput } from './definition-of-ready.js';
import type { CoverageRow } from './traceability.js';

/**
 * The spec quality score (P1-OBJ-07, FEAT-OBJ-020).
 *
 * **Dashboard-only and non-blocking**, and that is the whole design constraint
 * rather than a caveat on it. Every input here is a proxy: RFC-2119 keyword
 * density measures phrasing, not clarity; traceability coverage measures whether
 * links were recorded, not whether the work is right. A composite of proxies
 * makes a fine trend line and a terrible gate — the moment it blocks, people
 * optimise the proxies, and a spec written to score well is not the same
 * artifact as a spec written to be understood.
 *
 * So this reports and never refuses. The checks that *do* refuse are elsewhere
 * and are individually defensible: the Definition-of-Ready gate (ADR-0031) and
 * the evidence gate. This is the number you watch move.
 *
 * It shares its criterion scoring with the DoR gate deliberately. Two
 * implementations of "is this criterion well-formed" would disagree eventually,
 * and the disagreement would show up as a card the dashboard calls good and the
 * gate refuses.
 */

export interface SpecQualityInput {
  readonly workItemId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly nonGoals: readonly string[];
  /** From the traceability graph (P1-GATE-08). Empty when nothing is linked yet. */
  readonly coverage: readonly CoverageRow[];
}

export interface SubScore {
  readonly name: string;
  /** 0–1. */
  readonly value: number;
  /** How much of the composite this contributes. */
  readonly weight: number;
  readonly detail: string;
}

export interface SpecQualityScore {
  readonly workItemId: string;
  /** 0–100, rounded. A number to watch, never a threshold to pass. */
  readonly score: number;
  readonly sub: readonly SubScore[];
  /**
   * True when there was too little to measure.
   *
   * A card with no criteria scores 0 on everything, which reads as "very bad
   * spec" when the truth is "nothing to score yet". Those are different, and a
   * dashboard that conflates them teaches people to distrust it.
   */
  readonly insufficientData: boolean;
}

/** Weights, as data. They are judgement calls and should be visible as such. */
export const QUALITY_WEIGHTS = {
  acPresence: 0.25,
  acScored: 0.3,
  nonGoals: 0.15,
  traceability: 0.3,
} as const;

/**
 * Computes the composite.
 *
 * Pure. The traceability half arrives already queried, so the score is
 * reproducible from what was recorded rather than from a live database — the
 * same property that makes a gate verdict replayable.
 */
export function scoreSpecQuality(input: SpecQualityInput): SpecQualityScore {
  const criteria = input.acceptanceCriteria;
  const scored = criteria.filter((text) => isScoredCriterion(text));

  // "Enough criteria to be a spec" tops out at three. A card with twelve
  // criteria is not four times better specified than one with three, and a
  // linear count would reward padding — which is exactly what a scored metric
  // gets when it can be gamed.
  const acPresence = Math.min(criteria.length, 3) / 3;
  const acScored = criteria.length === 0 ? 0 : scored.length / criteria.length;
  const nonGoals = input.nonGoals.length === 0 ? 0 : 1;

  const covered = input.coverage.filter((row) => row.hasEvidence).length;
  // Measured against the *criteria*, not against the edges that happen to exist:
  // dividing by the edge count would score a card with one linked criterion and
  // eleven unlinked ones as fully covered.
  const traceability = criteria.length === 0 ? 0 : Math.min(covered / criteria.length, 1);

  const sub: SubScore[] = [
    {
      name: 'ac-presence',
      value: acPresence,
      weight: QUALITY_WEIGHTS.acPresence,
      detail: `${String(criteria.length)} acceptance criteria`,
    },
    {
      name: 'ac-scored',
      value: acScored,
      weight: QUALITY_WEIGHTS.acScored,
      detail: `${String(scored.length)}/${String(criteria.length)} state a requirement rather than a wish`,
    },
    {
      name: 'non-goals',
      value: nonGoals,
      weight: QUALITY_WEIGHTS.nonGoals,
      detail:
        input.nonGoals.length === 0 ? 'none stated' : `${String(input.nonGoals.length)} stated`,
    },
    {
      name: 'traceability',
      value: traceability,
      weight: QUALITY_WEIGHTS.traceability,
      detail: `${String(covered)}/${String(criteria.length)} criteria linked to evidence`,
    },
  ];

  return {
    workItemId: input.workItemId,
    score: Math.round(sub.reduce((total, entry) => total + entry.value * entry.weight, 0) * 100),
    sub,
    // Nothing to score yet is not the same as scoring badly.
    insufficientData: criteria.length === 0,
  };
}

/** The DoR gate's view of a card, reused so the two never disagree about a criterion. */
export type SpecQualitySource = Pick<ReadinessInput, 'id' | 'acceptanceCriteria' | 'nonGoals'>;

/** Report. Says plainly that the number does not gate, because someone will ask. */
export function formatSpecQuality(score: SpecQualityScore): string {
  const lines = [
    score.insufficientData
      ? `${score.workItemId}: not enough to score yet — no acceptance criteria`
      : `${score.workItemId}: spec quality ${String(score.score)}/100`,
    '',
  ];
  for (const entry of score.sub) {
    lines.push(
      `  ${entry.name.padEnd(14)} ${String(Math.round(entry.value * 100)).padStart(3)}%  (weight ${entry.weight.toFixed(2)})  ${entry.detail}`,
    );
  }
  lines.push('');
  lines.push('This number is observed, not enforced — every input is a proxy, and a spec');
  lines.push('written to score well is not the same artifact as one written to be understood.');
  return lines.join('\n');
}

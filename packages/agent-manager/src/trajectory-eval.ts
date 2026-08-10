import { createHash } from 'node:crypto';

/**
 * The trajectory-evaluation harness (P1-EVAL-01, FEAT-QA-001).
 *
 * Every gate in this product judges an *artifact*: did the tests pass, does the
 * claim cite something, is the criterion scored. None of them judges the
 * **path** — whether the orchestrator decomposed sensibly, whether the reviewer
 * looked where the bug was, whether the spec-writer asked the question that
 * mattered. A run can produce a passing artifact by a route nobody would endorse,
 * and today nothing notices.
 *
 * The obvious harness for that is an LLM judge scoring trajectories, and the
 * obvious harness is the one this project is least entitled to trust. So the
 * judge is not the disposer. **The golden set is.**
 *
 * The arrangement:
 *
 * - A **golden set** of trajectories with human-assigned verdicts. Small, real,
 *   and including the hard cases — a set of easy examples measures nothing,
 *   because every judge agrees on those.
 * - The judge is run against the golden set first. Its **agreement rate is its
 *   licence**: below the floor, its verdicts on unseen trajectories are not
 *   reported as verdicts at all. A judge nobody calibrated is a second opinion
 *   of unknown quality being counted as evidence.
 * - Disagreements are **mined**, not discarded. The cases a calibrated judge got
 *   wrong are the next golden entries, which is the only way the set gets harder
 *   rather than staler.
 */

export type TrajectoryVerdict = 'good' | 'acceptable' | 'bad';

export interface TrajectoryStep {
  readonly role: string;
  readonly action: string;
  /** What the step actually produced, for a judge to look at. */
  readonly outcome: string;
}

export interface Trajectory {
  readonly id: string;
  readonly agent: 'orchestrator' | 'spec-writer' | 'reviewer';
  readonly task: string;
  readonly steps: readonly TrajectoryStep[];
}

export interface GoldenEntry {
  readonly trajectory: Trajectory;
  /** Assigned by a human. This is the ground truth the judge is measured against. */
  readonly verdict: TrajectoryVerdict;
  /** Why — so a later disagreement can be argued with rather than just counted. */
  readonly because: string;
  /**
   * Whether this case is hard.
   *
   * Tracked because a golden set of easy cases measures nothing: every judge
   * agrees on the obvious ones, and a 95% agreement rate over easy examples
   * licenses a judge that fails on everything that matters.
   */
  readonly hard: boolean;
}

/** A judge proposes a verdict. It never disposes — see the module note. */
export type TrajectoryJudge = (
  trajectory: Trajectory,
) => Promise<{ verdict: TrajectoryVerdict; confidence: number; because: string }>;

/** Below this agreement on the hard cases, a judge's verdicts are not reported. */
export const CALIBRATION_FLOOR = 0.7;

/** Fewer hard cases than this and the agreement rate is not a measurement. */
export const MIN_HARD_CASES = 5;

export interface Calibration {
  readonly agreement: number;
  /** Agreement restricted to the hard cases — the number that actually licenses. */
  readonly hardAgreement: number;
  readonly hardCases: number;
  /** Whether this judge's unseen verdicts may be reported as verdicts. */
  readonly licensed: boolean;
  readonly reason: string;
  /** Cases the judge got wrong — the next golden entries (hard-case mining). */
  readonly disagreements: readonly {
    readonly id: string;
    readonly expected: TrajectoryVerdict;
    readonly got: TrajectoryVerdict;
  }[];
}

/**
 * Measures a judge against the golden set.
 *
 * Agreement is computed twice, and only the hard number licenses. Overall
 * agreement is reported because it is what people quote, and separating them is
 * the only way to stop a set padded with easy cases from certifying a judge that
 * fails on everything consequential.
 */
export async function calibrate(
  golden: readonly GoldenEntry[],
  judge: TrajectoryJudge,
): Promise<Calibration> {
  const disagreements: { id: string; expected: TrajectoryVerdict; got: TrajectoryVerdict }[] = [];
  let agreed = 0;
  let hardAgreed = 0;
  const hard = golden.filter((entry) => entry.hard);

  for (const entry of golden) {
    const ruling = await judge(entry.trajectory);
    if (ruling.verdict === entry.verdict) {
      agreed += 1;
      if (entry.hard) hardAgreed += 1;
    } else {
      disagreements.push({
        id: entry.trajectory.id,
        expected: entry.verdict,
        got: ruling.verdict,
      });
    }
  }

  const agreement = golden.length === 0 ? 0 : agreed / golden.length;
  const hardAgreement = hard.length === 0 ? 0 : hardAgreed / hard.length;

  if (hard.length < MIN_HARD_CASES) {
    return {
      agreement,
      hardAgreement,
      hardCases: hard.length,
      licensed: false,
      // Not "the judge failed" — nothing measured it. Reporting a licence off
      // three easy examples is how an unvalidated judge becomes evidence.
      reason: `only ${String(hard.length)} hard case(s) in the golden set — ${String(MIN_HARD_CASES)} are needed before an agreement rate means anything`,
      disagreements,
    };
  }

  const licensed = hardAgreement >= CALIBRATION_FLOOR;
  return {
    agreement,
    hardAgreement,
    hardCases: hard.length,
    licensed,
    reason: licensed
      ? `agrees with the human verdict on ${(hardAgreement * 100).toFixed(0)}% of hard cases`
      : `agrees on only ${(hardAgreement * 100).toFixed(0)}% of hard cases (floor ${(CALIBRATION_FLOOR * 100).toFixed(0)}%) — its verdicts on unseen trajectories are observations, not findings`,
    disagreements,
  };
}

export type EvaluationOutcome =
  | { readonly reported: true; readonly verdict: TrajectoryVerdict; readonly because: string }
  | { readonly reported: false; readonly reason: string; readonly observation: TrajectoryVerdict };

/**
 * Evaluates an unseen trajectory.
 *
 * An uncalibrated judge's opinion is still *returned* — it may well be useful to
 * a human — but it is returned as an observation with `reported: false`, so no
 * caller can mistake it for a finding by not reading carefully. Silently
 * withholding it would be its own kind of dishonesty; silently reporting it
 * would be worse.
 */
export async function evaluate(
  trajectory: Trajectory,
  judge: TrajectoryJudge,
  calibration: Calibration,
): Promise<EvaluationOutcome> {
  const ruling = await judge(trajectory);
  if (!calibration.licensed) {
    return { reported: false, reason: calibration.reason, observation: ruling.verdict };
  }
  return { reported: true, verdict: ruling.verdict, because: ruling.because };
}

/**
 * Turns a calibration run's disagreements into golden candidates.
 *
 * The cases a judge got wrong are the ones worth adding, and they are added as
 * **hard** — they demonstrably are. This is the only mechanism by which the set
 * gets harder rather than merely older.
 */
export function mineHardCases(
  calibration: Calibration,
  trajectories: readonly Trajectory[],
): readonly GoldenEntry[] {
  const byId = new Map(trajectories.map((entry) => [entry.id, entry]));
  return calibration.disagreements.flatMap((miss) => {
    const trajectory = byId.get(miss.id);
    if (trajectory === undefined) return [];
    return [
      {
        trajectory,
        verdict: miss.expected,
        because: `a judge scored this "${miss.got}" where a human scored it "${miss.expected}"`,
        hard: true,
      },
    ];
  });
}

/**
 * A trajectory's identity, for deduplicating a golden set.
 *
 * Hashed from the path, not the outcome: two runs reaching the same answer by
 * different routes are different trajectories, and collapsing them would hide
 * exactly what this harness exists to see.
 */
export function trajectoryHash(trajectory: Trajectory): string {
  return createHash('sha256')
    .update(
      `${trajectory.agent}:${trajectory.task}:${trajectory.steps
        .map((step) => `${step.role}/${step.action}`)
        .join('>')}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 16);
}

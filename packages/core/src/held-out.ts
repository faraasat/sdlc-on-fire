/**
 * Held-out acceptance criteria, and the delta they make computable
 * (P3-GATE-09, ADR-0037, `.research/techniques/42`).
 *
 * Every check this product's repair loop is graded on is a check it can read
 * and edit. That is not a small gap: SpecBench measures the distance between a
 * visible suite's pass rate and a held-out one's growing by roughly **27
 * percentage points per tenfold increase in lines of code**, reaching 100pp
 * above 25k — and finds that neither more search nor a better visible suite
 * closes it. Which means the one number that would tell us whether
 * fix-until-green is working is a number we could not compute.
 *
 * This makes it computable. **Δ = visible pass rate − held-out pass rate.**
 *
 * Three properties carry the design, and each is a way a held-out suite quietly
 * stops being held out:
 *
 * **They introduce no new requirements.** A held-out criterion composes what the
 * specification and the visible criteria already say into a realistic use. If it
 * asks for something nobody wrote down, a failure is a specification dispute
 * rather than a defect, and the delta stops meaning anything.
 *
 * **They are authored by a different actor.** Not a policy — an author check. A
 * held-out criterion written by the same actor that wrote the implementation is
 * held out from nobody.
 *
 * **They are never rendered into a context pack.** {@link HELD_OUT_REDACTION} is
 * what a consumer gets instead of the text. The exclusion is structural: the
 * pack-facing shape has no field the text could travel in, so a caller cannot
 * leak it by forgetting to filter.
 *
 * On where they live: not in the working tree, because anything in the tree is
 * readable by whatever is working in it. They sit with `evidence`, `approvals`
 * and `audit_log` — the records that are deliberately *not* rebuildable from git
 * because they are artifacts of the review process rather than derivable from
 * the card. `db:rebuild` does not touch them for the same reason it does not
 * touch an approval.
 */

/** What a consumer sees in place of held-out text. Never the text. */
export const HELD_OUT_REDACTION = '[held out — not visible to the authoring actor]';

export interface HeldOutCriterion {
  readonly id: string;
  readonly workItemId: string;
  /** The criterion itself. Never leaves the store. */
  readonly text: string;
  /** Who wrote it. Compared against the implementer, not trusted. */
  readonly authorActorId: string;
  readonly createdAt: string;
}

/** The pack-facing shape. There is no field the text could travel in. */
export interface HeldOutSummary {
  readonly workItemId: string;
  readonly count: number;
  readonly redaction: typeof HELD_OUT_REDACTION;
}

export function summariseHeldOut(
  workItemId: string,
  criteria: readonly HeldOutCriterion[],
): HeldOutSummary {
  return {
    workItemId,
    count: criteria.length,
    redaction: HELD_OUT_REDACTION,
  };
}

export const HELD_OUT_REFUSALS = [
  'same-author',
  'no-author',
  'empty-text',
  'restates-visible',
] as const;
export type HeldOutRefusal = (typeof HELD_OUT_REFUSALS)[number];

export interface HeldOutAdmission {
  readonly admitted: boolean;
  readonly refusal?: HeldOutRefusal | undefined;
  readonly because?: string | undefined;
}

/** Normalised for comparison: case, punctuation and filler removed. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !['the', 'a', 'an', 'is', 'are', 'and', 'to'].includes(word))
    .join(' ');
}

/**
 * Whether a proposed held-out criterion may be admitted.
 *
 * The same-author check is the whole point and it is deliberately not
 * overridable: a criterion written by the actor who will implement against it is
 * held out from nobody, and a flag permitting it would be used on the day
 * somebody is in a hurry — which is the day it matters.
 *
 * The restates-visible check is a guard against the cheapest way to make the
 * delta look good: copy the visible criteria into the held-out set. Then Δ is
 * zero by construction and reads as a passing grade.
 */
export function admitHeldOut(input: {
  readonly text: string;
  readonly authorActorId: string;
  readonly implementerActorId: string | null;
  readonly visibleCriteria: readonly string[];
}): HeldOutAdmission {
  if (input.text.trim() === '') {
    return { admitted: false, refusal: 'empty-text', because: 'a criterion with no text' };
  }
  if (input.authorActorId.trim() === '') {
    return {
      admitted: false,
      refusal: 'no-author',
      because: 'held-out criteria carry an author, because "a different actor" is the whole check',
    };
  }
  if (input.implementerActorId !== null && input.authorActorId === input.implementerActorId) {
    return {
      admitted: false,
      refusal: 'same-author',
      because:
        'a criterion written by the actor implementing against it is held out from nobody ' +
        '(ADR-0037: a green suite you wrote needs an independent signal)',
    };
  }

  const proposed = normalise(input.text);
  const duplicate = input.visibleCriteria.find((visible) => normalise(visible) === proposed);
  if (duplicate !== undefined) {
    return {
      admitted: false,
      refusal: 'restates-visible',
      because: `restates the visible criterion "${duplicate}" — copying the visible set makes Δ zero by construction, which reads as a passing grade`,
    };
  }

  return { admitted: true };
}

export interface CriterionResult {
  readonly id: string;
  readonly passed: boolean;
}

export interface HeldOutDelta {
  readonly visiblePassed: number;
  readonly visibleTotal: number;
  readonly heldOutPassed: number;
  readonly heldOutTotal: number;
  /** visible rate − held-out rate, in percentage points. `null` when unmeasurable. */
  readonly deltaPp: number | null;
  /** Why it is unmeasurable, when it is. */
  readonly because: string;
}

/**
 * The number this whole feature exists to produce.
 *
 * Returns `null` rather than `0` when either side is empty, and the distinction
 * is the important one: a delta of zero says "the held-out suite agrees with the
 * visible one", and no held-out criteria at all says nothing whatsoever. Those
 * look identical in any implementation that defaults to zero, and the second is
 * the state every project starts in.
 */
export function heldOutDelta(
  visible: readonly CriterionResult[],
  heldOut: readonly CriterionResult[],
): HeldOutDelta {
  const visiblePassed = visible.filter((entry) => entry.passed).length;
  const heldOutPassed = heldOut.filter((entry) => entry.passed).length;

  const base = {
    visiblePassed,
    visibleTotal: visible.length,
    heldOutPassed,
    heldOutTotal: heldOut.length,
  };

  if (heldOut.length === 0) {
    return {
      ...base,
      deltaPp: null,
      because:
        'no held-out criteria — the delta is not zero, it is unmeasured, and those are ' +
        'different states (P3-GATE-09)',
    };
  }
  if (visible.length === 0) {
    return { ...base, deltaPp: null, because: 'no visible criteria to compare against' };
  }

  const deltaPp =
    Math.round(
      ((visiblePassed / visible.length - heldOutPassed / heldOut.length) * 100 + Number.EPSILON) *
        10,
    ) / 10;

  return {
    ...base,
    deltaPp,
    because:
      deltaPp <= 0
        ? 'the held-out criteria do at least as well as the visible ones'
        : `the visible criteria pass ${String(deltaPp)}pp more often than the held-out ones`,
  };
}

/**
 * The gap SpecBench predicts for a change of this size, in percentage points.
 *
 * Roughly 27pp per tenfold increase in lines of code, anchored so a ~1k-line
 * change expects nothing. The **shape** is adopted from one 2026 benchmark over
 * 30 systems-level tasks; the constant is named here rather than buried, so it
 * is a parameter somebody can refresh rather than a magic number.
 */
export const GAP_PP_PER_DECADE = 27;
export const GAP_BASELINE_LOC = 1_000;

export function expectedGapPp(changedLines: number): number {
  if (changedLines <= GAP_BASELINE_LOC) return 0;
  const decades = Math.log10(changedLines / GAP_BASELINE_LOC);
  return Math.min(100, Math.round(decades * GAP_PP_PER_DECADE * 10) / 10);
}

export function formatHeldOutDelta(delta: HeldOutDelta): string {
  const lines = [
    `visible ${String(delta.visiblePassed)}/${String(delta.visibleTotal)}, ` +
      `held-out ${String(delta.heldOutPassed)}/${String(delta.heldOutTotal)}`,
  ];
  lines.push(
    delta.deltaPp === null
      ? `  Δ unmeasured — ${delta.because}`
      : `  Δ ${String(delta.deltaPp)}pp — ${delta.because}`,
  );
  return lines.join('\n');
}

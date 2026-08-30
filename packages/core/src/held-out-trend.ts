/**
 * Whether the visible/held-out gap is widening (P7-HELDOUT-02, `techniques/42`).
 *
 * `heldOutDelta` answers "what is the gap right now". That number alone is
 * nearly unreadable: a 12pp gap on a large change is expected, and a 4pp gap on
 * a tiny one is alarming. What is legible is the **direction over time** — and
 * a widening gap is the specific signal that the repair loop has started
 * satisfying the checks it can see rather than making the software work, since
 * that is the only change that moves the two rates apart.
 *
 * **Arithmetic, never a judgement.** The disposer for "is this getting worse"
 * is a subtraction over stored samples (ADR-0040). Asking a model would produce
 * a fluent answer to the one question whose value depends entirely on nobody
 * having an opinion about it.
 *
 * **Fewer than two samples is unmeasured, not stable.** A single point has no
 * direction. Reporting it as stable is the reassuring answer rather than the
 * true one, and this whole feature exists because reassuring answers are what a
 * fix-until-green loop produces on its own.
 */

export interface HeldOutSample {
  readonly workItemId: string;
  readonly measuredAt: string;
  readonly visiblePassed: number;
  readonly visibleTotal: number;
  readonly heldOutPassed: number;
  readonly heldOutTotal: number;
  /** null when either side was empty — never 0. */
  readonly deltaPp: number | null;
  readonly changedLines?: number | undefined;
}

export const TREND_DIRECTIONS = ['widening', 'narrowing', 'flat', 'unmeasured'] as const;
export type TrendDirection = (typeof TREND_DIRECTIONS)[number];

/**
 * Movement below this is noise, not a trend.
 *
 * A threshold rather than a strict inequality because pass rates are ratios of
 * small integers: one criterion flipping on a five-item set moves the delta
 * 20pp, and one flipping on a fifty-item set moves it 2pp. Without a floor,
 * every ordinary run reports a direction and the signal stops being one.
 */
export const TREND_NOISE_PP = 2;

export interface HeldOutTrend {
  readonly direction: TrendDirection;
  /** Latest delta minus earliest, in percentage points. null when unmeasured. */
  readonly changePp: number | null;
  readonly first: HeldOutSample | null;
  readonly latest: HeldOutSample | null;
  /** Samples that carried a delta — the ones the trend is actually over. */
  readonly measuredSamples: number;
  readonly because: string;
}

function byTime(a: HeldOutSample, b: HeldOutSample): number {
  return Date.parse(a.measuredAt) - Date.parse(b.measuredAt);
}

/**
 * The direction of the gap across samples.
 *
 * Unmeasured samples are **dropped, not treated as zero**. A run with no
 * held-out criteria says nothing about the gap, and folding it in as a zero
 * would drag every trend toward "narrowing" exactly on the projects that have
 * not started measuring — which is the population most likely to be gaming its
 * checks without knowing it.
 */
export function heldOutTrend(samples: readonly HeldOutSample[]): HeldOutTrend {
  const measured = [...samples].filter((sample) => sample.deltaPp !== null).sort(byTime);
  const first = measured[0] ?? null;
  const latest = measured[measured.length - 1] ?? null;

  if (measured.length < 2) {
    return {
      direction: 'unmeasured',
      changePp: null,
      first,
      latest,
      measuredSamples: measured.length,
      because:
        measured.length === 0
          ? 'no measured deltas yet — the gap is unknown, which is not the same as small'
          : 'one measured delta — a single point has no direction, and calling it stable would be the reassuring answer rather than the true one',
    };
  }

  const changePp =
    Math.round(((latest?.deltaPp ?? 0) - (first?.deltaPp ?? 0) + Number.EPSILON) * 10) / 10;

  if (Math.abs(changePp) < TREND_NOISE_PP) {
    return {
      direction: 'flat',
      changePp,
      first,
      latest,
      measuredSamples: measured.length,
      because: `moved ${String(changePp)}pp across ${String(measured.length)} samples — under the ${String(TREND_NOISE_PP)}pp noise floor`,
    };
  }

  return {
    direction: changePp > 0 ? 'widening' : 'narrowing',
    changePp,
    first,
    latest,
    measuredSamples: measured.length,
    because:
      changePp > 0
        ? `the visible suite is pulling ${String(changePp)}pp further ahead of the held-out one — the signature of a loop satisfying the checks it can see`
        : `the held-out suite is closing on the visible one by ${String(Math.abs(changePp))}pp`,
  };
}

export function formatHeldOutTrend(trend: HeldOutTrend): string {
  const lines = [
    trend.direction === 'unmeasured'
      ? `trend: unmeasured — ${trend.because}`
      : `trend: ${trend.direction} (${trend.changePp === null ? '?' : `${trend.changePp > 0 ? '+' : ''}${String(trend.changePp)}pp`}) over ${String(trend.measuredSamples)} samples`,
  ];
  if (trend.direction !== 'unmeasured') lines.push(`  ${trend.because}`);
  if (trend.first !== null && trend.latest !== null && trend.first !== trend.latest) {
    lines.push(
      `  ${trend.first.measuredAt} → ${trend.latest.measuredAt}`,
      `  Δ ${String(trend.first.deltaPp)}pp → ${String(trend.latest.deltaPp)}pp`,
    );
  }
  if (trend.direction === 'widening') {
    lines.push(
      '',
      'A widening gap is the one signal worth acting on: the visible checks are',
      'being satisfied faster than the held-out ones, which is what fixing the',
      'scoreboard looks like from the outside.',
    );
  }
  return lines.join('\n');
}

import type { Rate } from './visibility-analysis.js';

/**
 * Visibility over time (P7-VISIBILITY-01, ADR-0074).
 *
 * [P5-VIZ] measures visibility once. Once is not a measurement of anything you
 * can act on — the question is never "what is the mention rate" but "is it
 * moving", and a single run cannot answer that at any sample size.
 *
 * **Wilson intervals throughout, including in the comparison.** This is the
 * whole design. A trend built on point estimates reports movement on noise: two
 * runs of 40 prompts differing by 5 percentage points is well inside what the
 * same conditions produce twice, and a chart of those point estimates will show
 * a confident line through pure sampling variation. So the rule here is
 * blunt — **two rates whose intervals overlap have not been shown to differ**,
 * and this reports them as indistinguishable rather than picking a direction.
 *
 * That will report "no change" often, on runs where a point estimate would have
 * shown a story. That is the correct outcome. The alternative is a visibility
 * dashboard that manufactures narratives, which is worse than no dashboard
 * because somebody will act on it.
 *
 * **ADR-0074's boundaries are upstream of this and hold here too.** A snapshot
 * is only ever derived from a corpus produced through documented APIs; there is
 * no code path in this module that accepts a hand-entered rate, because a rate
 * with no corpus behind it has no provenance and is therefore not evidence.
 */

export interface VisibilitySnapshot {
  /** ISO timestamp of the run this came from. */
  readonly at: string;
  readonly subject: string;
  readonly host: string;
  readonly answered: Rate;
  readonly mention: Rate;
  readonly citation: Rate;
  /** Cells that failed. Carried so a reader can see how much of the run worked. */
  readonly failures: number;
}

export const VISIBILITY_LEVELS = ['answered', 'mention', 'citation'] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

export const TREND_VERDICTS = ['improved', 'declined', 'indistinguishable', 'unmeasured'] as const;
export type TrendVerdict = (typeof TREND_VERDICTS)[number];

export interface LevelTrend {
  readonly level: VisibilityLevel;
  readonly verdict: TrendVerdict;
  readonly first: Rate | null;
  readonly latest: Rate | null;
  /** Point-estimate difference in percentage points. Reported, never acted on alone. */
  readonly changePp: number | null;
  readonly because: string;
}

/**
 * Whether two Wilson intervals are disjoint.
 *
 * Non-overlapping intervals is a **conservative** test — it is stricter than a
 * proper two-proportion test, so it will call some real differences
 * indistinguishable. That is the direction to err in for a number somebody will
 * put in front of a stakeholder: a missed improvement costs nothing, and a
 * declared improvement that was noise costs credibility exactly once.
 */
export function intervalsDisjoint(a: Rate, b: Rate): boolean {
  return a.high < b.low || b.high < a.low;
}

function trendFor(level: VisibilityLevel, first: Rate | null, latest: Rate | null): LevelTrend {
  // No reference-identity check here: `visibilityTrend` supplies `latest` as
  // null below two snapshots, which is the same condition said once, explicitly,
  // rather than twice with one of them relying on object identity.
  if (first === null || latest === null) {
    return {
      level,
      verdict: 'unmeasured',
      first,
      latest,
      changePp: null,
      because:
        first === null
          ? 'no snapshots'
          : 'one snapshot — a single run cannot show movement at any sample size',
    };
  }

  const changePp = Math.round((latest.value - first.value) * 1000) / 10;

  if (!intervalsDisjoint(first, latest)) {
    return {
      level,
      verdict: 'indistinguishable',
      first,
      latest,
      changePp,
      because: `intervals overlap (${(first.low * 100).toFixed(1)}–${(first.high * 100).toFixed(1)}% vs ${(latest.low * 100).toFixed(1)}–${(latest.high * 100).toFixed(1)}%) — a ${String(changePp)}pp point-estimate move that the sample does not support`,
    };
  }

  return {
    level,
    verdict: latest.value > first.value ? 'improved' : 'declined',
    first,
    latest,
    changePp,
    because: `intervals do not overlap — ${String(Math.abs(changePp))}pp ${latest.value > first.value ? 'higher' : 'lower'} on ${String(latest.attempts)} attempts`,
  };
}

export interface VisibilityTrend {
  readonly subject: string;
  readonly snapshots: number;
  readonly levels: readonly LevelTrend[];
  /** Levels whose movement the sample actually supports. */
  readonly moved: readonly VisibilityLevel[];
  readonly because: string;
}

/**
 * The trend across snapshots. Pure.
 *
 * Compares the **first and latest** rather than the last two: a rate that dipped
 * and recovered has not improved, and comparing adjacent pairs would say it had.
 */
export function visibilityTrend(snapshots: readonly VisibilitySnapshot[]): VisibilityTrend {
  const ordered = [...snapshots].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = ordered[0] ?? null;
  const latest = ordered.length > 1 ? (ordered[ordered.length - 1] ?? null) : null;

  const levels = VISIBILITY_LEVELS.map((level) =>
    trendFor(level, first === null ? null : first[level], latest === null ? null : latest[level]),
  );

  const moved = levels
    .filter((entry) => entry.verdict === 'improved' || entry.verdict === 'declined')
    .map((entry) => entry.level);

  return {
    subject: first?.subject ?? '',
    snapshots: ordered.length,
    levels,
    moved,
    because:
      ordered.length === 0
        ? 'no visibility runs recorded'
        : ordered.length === 1
          ? 'one run — visibility is a trend, and one point is not one'
          : moved.length === 0
            ? `${String(ordered.length)} runs, no level moved beyond what the sample supports`
            : `${String(moved.length)} level(s) moved: ${moved.join(', ')}`,
  };
}

function pct(rate: Rate): string {
  return `${(rate.value * 100).toFixed(1)}% [${(rate.low * 100).toFixed(1)}–${(rate.high * 100).toFixed(1)}] (${String(rate.hits)}/${String(rate.attempts)})`;
}

export function formatVisibilityTrend(trend: VisibilityTrend): string {
  if (trend.snapshots === 0) return `no visibility runs recorded — ${trend.because}`;

  const lines = [`${trend.subject}: ${String(trend.snapshots)} run(s) — ${trend.because}`, ''];
  for (const level of trend.levels) {
    lines.push(`  ${level.level.padEnd(9)} ${level.verdict}`);
    if (level.first !== null) lines.push(`    first  ${pct(level.first)}`);
    if (level.latest !== null) lines.push(`    latest ${pct(level.latest)}`);
    lines.push(`    ${level.because}`);
  }
  if (trend.moved.length === 0 && trend.snapshots > 1) {
    lines.push(
      '',
      'Reporting no change is the honest outcome more often than not. A trend',
      'built on point estimates would have drawn a line through the sampling',
      'variation, and somebody would have acted on it.',
    );
  }
  return lines.join('\n');
}

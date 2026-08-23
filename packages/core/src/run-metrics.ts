import { RUN_FAILURE_REASONS, type RunFailureReason } from './run-record.js';

/**
 * Agent-loop measures over the run rows (P6-INSTRUMENT-02; FEAT-MET-003/008/010).
 *
 * The rows only started existing with P6-WRITEPATH-01. Everything here is
 * arithmetic over them, kept in `core` and away from SQL so it can be tested
 * against rows rather than against a database.
 *
 * **The governing rule is the one the DORA report already follows: report
 * nothing rather than zero.** A project with no cost data and one that spent
 * nothing produce the same `0.00`, and one of those is a measurement while the
 * other is an absence pretending to be one. Every aggregate here is `null` when
 * it has nothing to aggregate, and the formatter says "not available".
 */

export interface RunRow {
  readonly id: string;
  readonly workItemId: string;
  readonly skillId: string | null;
  readonly status: string | null;
  readonly failureReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly turns: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * How much of what was sent came out of the prompt cache (FEAT-MET-011).
 *
 * The denominator is everything the provider had to take in — cache reads plus
 * cache writes plus fresh input. Dividing by fresh input alone would make a run
 * that cached nothing report a rate of zero *and* a run that cached everything
 * report infinity, which is the arithmetic of a metric nobody checked.
 *
 * Distinct from `packMetrics.cacheableFraction`, and the gap between them is the
 * useful signal: a pack that is 80% cacheable and never hits is a stable prefix
 * that is not actually stable.
 */
export interface CacheSummary {
  readonly readTokens: number | null;
  readonly creationTokens: number | null;
  /** 0..1, or `null` when no run reported cache accounting at all. */
  readonly hitRate: number | null;
  readonly runsReporting: number;
}

export interface TrajectorySummary {
  /** Total turns across runs that reported them. `null` when none did. */
  readonly turns: number | null;
  readonly turnsPerRun: number | null;
  readonly runsReporting: number;
  /**
   * Tool calls are **not** reported, and this says so rather than substituting
   * turns for them.
   *
   * `--output-format json` carries `num_turns` and no tool-call record. Counting
   * tool calls needs `stream-json`, which is a different transport contract than
   * the one verified against the real binary. Reporting turns under the name
   * "tool calls" would be a substitution invisible in a dashboard.
   */
  readonly toolCalls: null;
}

export interface RunCount {
  readonly key: string;
  readonly runs: number;
  readonly passed: number;
  readonly failed: number;
  /** Runs that could not execute at all — kept apart from work that failed. */
  readonly errored: number;
}

export interface RunCostSummary {
  /** `null` when no run reported a cost. Never 0. */
  readonly totalUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** How many runs actually carried usage, so a partial total is visibly partial. */
  readonly runsWithUsage: number;
  readonly runs: number;
}

export interface RunMetrics {
  readonly runs: number;
  readonly byWorkItem: readonly RunCount[];
  readonly bySkill: readonly RunCount[];
  readonly cost: RunCostSummary;
  /** Counted over the closed vocabulary, so a reason with zero runs still appears. */
  readonly failureReasons: readonly { readonly reason: RunFailureReason; readonly runs: number }[];
  /**
   * Work items whose run count is far above the median (FEAT-MET-003's purpose).
   *
   * The point of counting runs is not the count; it is finding the card that
   * took eleven attempts, because that is a proxy for a spec nobody could work
   * from. A raw list leaves the reader to spot it.
   */
  readonly outliers: readonly RunCount[];
  readonly cache: CacheSummary;
  readonly trajectory: TrajectorySummary;
}

function tally(rows: readonly RunRow[], keyOf: (row: RunRow) => string | null): RunCount[] {
  const counts = new Map<
    string,
    { runs: number; passed: number; failed: number; errored: number }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const entry = counts.get(key) ?? { runs: 0, passed: 0, failed: 0, errored: 0 };
    entry.runs += 1;
    if (row.status === 'pass') entry.passed += 1;
    else if (row.status === 'fail') entry.failed += 1;
    else if (row.status === 'error') entry.errored += 1;
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
}

/**
 * Cards taking unusually many runs.
 *
 * Median-based rather than mean-based, and requiring at least three cards before
 * it says anything. A mean is dragged by the very outlier being looked for — one
 * card at forty runs raises the threshold above itself — and with two cards
 * "unusual" is not a claim anything supports.
 */
export function runOutliers(counts: readonly RunCount[]): readonly RunCount[] {
  if (counts.length < 3) return [];
  const sorted = [...counts].map((c) => c.runs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  if (median <= 0) return [];
  return counts.filter((count) => count.runs >= median * 2 && count.runs > median);
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

export function runMetrics(rows: readonly RunRow[]): RunMetrics {
  const byWorkItem = tally(rows, (row) => row.workItemId);

  return {
    runs: rows.length,
    byWorkItem,
    bySkill: tally(rows, (row) => row.skillId),
    cost: {
      totalUsd: sumOrNull(rows.map((row) => row.costUsd)),
      inputTokens: sumOrNull(rows.map((row) => row.inputTokens)),
      outputTokens: sumOrNull(rows.map((row) => row.outputTokens)),
      runsWithUsage: rows.filter((row) => row.costUsd !== null || row.inputTokens !== null).length,
      runs: rows.length,
    },
    // Over the whole vocabulary rather than over what appeared. A reason that
    // never fires is information — "no run has ever failed the output contract"
    // is a different statement from "that reason is not tracked".
    failureReasons: RUN_FAILURE_REASONS.map((reason) => ({
      reason,
      runs: rows.filter((row) => row.failureReason === reason).length,
    })),
    outliers: runOutliers(byWorkItem),
    cache: cacheSummary(rows),
    trajectory: trajectorySummary(rows),
  };
}

export function cacheSummary(rows: readonly RunRow[]): CacheSummary {
  const reporting = rows.filter(
    (row) => row.cacheReadTokens !== null || row.cacheCreationTokens !== null,
  );
  const read = sumOrNull(rows.map((row) => row.cacheReadTokens));
  const creation = sumOrNull(rows.map((row) => row.cacheCreationTokens));
  const fresh = sumOrNull(rows.map((row) => row.inputTokens)) ?? 0;
  const denominator = (read ?? 0) + (creation ?? 0) + fresh;

  return {
    readTokens: read,
    creationTokens: creation,
    // `null`, not 0. No run reporting cache accounting and every run missing the
    // cache are different facts, and only one of them is a problem to fix.
    hitRate: reporting.length === 0 || denominator === 0 ? null : (read ?? 0) / denominator,
    runsReporting: reporting.length,
  };
}

export function trajectorySummary(rows: readonly RunRow[]): TrajectorySummary {
  const reporting = rows.filter((row) => row.turns !== null);
  const turns = sumOrNull(rows.map((row) => row.turns));
  return {
    turns,
    turnsPerRun: turns === null || reporting.length === 0 ? null : turns / reporting.length,
    runsReporting: reporting.length,
    toolCalls: null,
  };
}

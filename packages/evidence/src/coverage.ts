/**
 * Coverage parsing and baseline delta (P2-QA-02, contract 03 §3).
 *
 * The payload shape is fixed by the contract: `{ format, pct, regressions:
 * {file, before, after}[], ok }`, with `max_regression_pp` on the policy.
 * What is worth arguing about is everything the shape does not settle.
 *
 * **Per-file, not just the total.** A repository's overall percentage can rise
 * while the one file that matters collapses — add a thousand covered lines of
 * generated types and you can delete every test for the payments module
 * without the number moving the wrong way. Averaging is how coverage becomes a
 * metric people report rather than one that catches anything, so the delta is
 * computed per file and the total is reported alongside rather than instead.
 *
 * **A missing baseline is not a pass.** There is nothing to compare against on
 * the first run, and the tempting answer — treat "no baseline" as fine — makes
 * deleting the baseline file the cheapest way through the gate. So a run with
 * no baseline reports `established`: it records the numbers and says plainly
 * that no delta was computed. The gate can decide that is acceptable for a
 * first run; what it cannot do is mistake it for a comparison that happened.
 *
 * **A file that vanished from the report did not improve.** Exclude it,
 * rename it, or delete the only test that touched it, and a naive diff sees a
 * file that is no longer regressing. It is reported as `dropped`, because the
 * coverage of code nobody measures is not known to be good.
 */

export const COVERAGE_FORMATS = ['lcov', 'istanbul-summary', 'cobertura'] as const;
export type CoverageFormat = (typeof COVERAGE_FORMATS)[number];

export interface FileCoverage {
  readonly file: string;
  /** Percentage of lines covered, 0–100. */
  readonly pct: number;
  readonly covered: number;
  readonly total: number;
}

export interface CoverageReport {
  readonly format: CoverageFormat;
  readonly files: readonly FileCoverage[];
  /** Line coverage across every file in the report. */
  readonly pct: number;
}

const percent = (covered: number, total: number): number =>
  total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100;

function summarise(format: CoverageFormat, files: FileCoverage[]): CoverageReport {
  const covered = files.reduce((sum, file) => sum + file.covered, 0);
  const total = files.reduce((sum, file) => sum + file.total, 0);
  return {
    format,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    pct: percent(covered, total),
  };
}

/**
 * Parses lcov `.info`.
 *
 * The two records that matter are `SF:` (the file) and `end_of_record`. Line
 * totals come from `LF:`/`LH:` when present and are recomputed from the `DA:`
 * lines when they are not — some producers omit the summary records, and a
 * parser that trusts them exclusively reports 0% for a fully covered file.
 */
export function parseLcov(raw: string): CoverageReport {
  const files: FileCoverage[] = [];
  let file: string | null = null;
  let found: number | null = null;
  let hit: number | null = null;
  let daTotal = 0;
  let daHit = 0;

  const flush = (): void => {
    if (file === null) return;
    const total = found ?? daTotal;
    const covered = hit ?? daHit;
    files.push({ file, covered, total, pct: percent(covered, total) });
    file = null;
    found = null;
    hit = null;
    daTotal = 0;
    daHit = 0;
  };

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text.startsWith('SF:')) {
      flush();
      file = text.slice(3);
    } else if (text.startsWith('LF:')) {
      found = Number.parseInt(text.slice(3), 10);
    } else if (text.startsWith('LH:')) {
      hit = Number.parseInt(text.slice(3), 10);
    } else if (text.startsWith('DA:')) {
      const [, count] = text.slice(3).split(',');
      daTotal += 1;
      if (count !== undefined && Number.parseInt(count, 10) > 0) daHit += 1;
    } else if (text === 'end_of_record') {
      flush();
    }
  }
  // A final record with no `end_of_record` is a truncated report, but the file
  // it names was still measured; dropping it would understate coverage.
  flush();

  return summarise('lcov', files);
}

/** Parses Istanbul's `coverage-summary.json`. */
export function parseIstanbulSummary(raw: string): CoverageReport {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const files: FileCoverage[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    // `total` is the roll-up, not a file. Counting it would double every
    // number and put a file named "total" in the per-file list.
    if (key === 'total') continue;
    const lines = (value as { lines?: { total?: number; covered?: number } }).lines;
    if (lines === undefined) continue;
    const total = lines.total ?? 0;
    const covered = lines.covered ?? 0;
    files.push({ file: key, covered, total, pct: percent(covered, total) });
  }

  return summarise('istanbul-summary', files);
}

/**
 * Parses Cobertura XML.
 *
 * Reads `<class filename= line-rate=>` rather than the document-level
 * `line-rate`, because the per-file rate is what a delta needs. Line counts
 * come from the `<line>` elements where present; `line-rate` alone gives a
 * percentage with no denominator, and a percentage without a denominator
 * cannot be re-aggregated.
 */
export function parseCobertura(raw: string): CoverageReport {
  const files: FileCoverage[] = [];
  const classes = raw.matchAll(/<class\b[^>]*filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g);

  for (const match of classes) {
    const file = match[1];
    const body = match[2] ?? '';
    if (file === undefined) continue;

    const lines = [...body.matchAll(/<line\b[^>]*\bhits="(\d+)"/g)];
    if (lines.length > 0) {
      const covered = lines.filter((line) => Number.parseInt(line[1] ?? '0', 10) > 0).length;
      files.push({ file, covered, total: lines.length, pct: percent(covered, lines.length) });
      continue;
    }

    // No `<line>` elements: fall back to the class's own rate, and say so by
    // carrying a zero denominator rather than inventing one.
    const rate = /line-rate="([0-9.]+)"/.exec(match[0]);
    const pct = rate?.[1] === undefined ? 0 : Math.round(Number.parseFloat(rate[1]) * 10_000) / 100;
    files.push({ file, covered: 0, total: 0, pct });
  }

  return summarise('cobertura', files);
}

export interface CoverageRegression {
  readonly file: string;
  readonly before: number;
  readonly after: number;
}

export type DeltaStatus = 'ok' | 'regressed' | 'established';

export interface CoverageDelta {
  readonly format: CoverageFormat;
  readonly pct: number;
  /** Total-coverage change in percentage points. Zero when no baseline. */
  readonly totalDeltaPp: number;
  readonly regressions: readonly CoverageRegression[];
  /** Files present in the baseline and absent now — not an improvement. */
  readonly dropped: readonly string[];
  readonly status: DeltaStatus;
  readonly ok: boolean;
}

/** Percentage points a file may lose before it counts as a regression. */
export const DEFAULT_MAX_REGRESSION_PP = 0;

/**
 * Compares a coverage report against a baseline.
 *
 * `maxRegressionPp` is a per-file allowance, not a budget across the report:
 * ten files each losing a point is ten regressions, not one ten-point one.
 * Spreading a loss thinly is exactly how a total-based threshold is defeated.
 */
export function coverageDelta(
  current: CoverageReport,
  baseline: CoverageReport | null,
  maxRegressionPp: number = DEFAULT_MAX_REGRESSION_PP,
): CoverageDelta {
  if (baseline === null) {
    return {
      format: current.format,
      pct: current.pct,
      totalDeltaPp: 0,
      regressions: [],
      dropped: [],
      status: 'established',
      // Deliberately `false`. Nothing was compared, and a caller that reads
      // `ok` without reading `status` must not be told a check passed.
      ok: false,
    };
  }

  const before = new Map(baseline.files.map((file) => [file.file, file]));
  const regressions: CoverageRegression[] = [];

  for (const file of current.files) {
    const previous = before.get(file.file);
    if (previous === undefined) continue; // new file: nothing to regress from
    if (previous.pct - file.pct > maxRegressionPp) {
      regressions.push({ file: file.file, before: previous.pct, after: file.pct });
    }
  }

  const now = new Set(current.files.map((file) => file.file));
  const dropped = baseline.files.map((file) => file.file).filter((file) => !now.has(file));

  return {
    format: current.format,
    pct: current.pct,
    totalDeltaPp: Math.round((current.pct - baseline.pct) * 100) / 100,
    regressions,
    dropped,
    // A dropped file fails the check as surely as a regressed one. Removing a
    // file from the report is the cheapest possible way to stop it regressing.
    status: regressions.length > 0 || dropped.length > 0 ? 'regressed' : 'ok',
    ok: regressions.length === 0 && dropped.length === 0,
  };
}

/** Picks the parser from the file's own content, not from its extension. */
export function parseCoverage(raw: string): CoverageReport {
  const text = raw.trimStart();
  if (text.startsWith('<')) return parseCobertura(raw);
  if (text.startsWith('{')) return parseIstanbulSummary(raw);
  return parseLcov(raw);
}

export function formatCoverageDelta(delta: CoverageDelta): string {
  const lines: string[] = [];

  if (delta.status === 'established') {
    lines.push(
      `Coverage ${String(delta.pct)}% (${delta.format}) — no baseline, so no delta was computed.`,
      'This run establishes one. It is not a passing comparison, and is not reported as one.',
    );
    return lines.join('\n');
  }

  const sign = delta.totalDeltaPp >= 0 ? '+' : '';
  lines.push(
    `Coverage ${String(delta.pct)}% (${sign}${String(delta.totalDeltaPp)}pp, ${delta.format})`,
  );

  for (const regression of delta.regressions) {
    lines.push(
      `  ✗ ${regression.file}: ${String(regression.before)}% → ${String(regression.after)}%`,
    );
  }
  for (const file of delta.dropped) {
    lines.push(`  ✗ ${file}: in the baseline, absent now — unmeasured is not covered`);
  }

  lines.push('', delta.ok ? 'No file lost coverage.' : 'Coverage regressed.');
  return lines.join('\n');
}

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_FORMATS,
  coverageDelta,
  formatCoverageDelta,
  parseCobertura,
  parseCoverage,
  parseLcov,
  type CoverageReport,
} from './coverage.js';

/**
 * P2-QA-02 — the delta.
 *
 * Parsing is exercised against real Vitest output next door; what is under
 * test here is the comparison, and specifically the three ways a coverage
 * check gets defeated without anyone lying: spread the loss thinly across
 * files, delete the baseline, or delete the file.
 */

const report = (files: readonly [string, number, number][]): CoverageReport => {
  const parsed = files.map(([file, covered, total]) => ({
    file,
    covered,
    total,
    pct: total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100,
  }));
  const covered = parsed.reduce((sum, f) => sum + f.covered, 0);
  const total = parsed.reduce((sum, f) => sum + f.total, 0);
  return {
    format: 'lcov',
    files: parsed,
    pct: total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100,
  };
};

describe('parseLcov', () => {
  it('recomputes line totals when LF/LH are absent', () => {
    // Some producers omit the summary records. A parser that trusts them
    // exclusively reports 0% for a fully covered file.
    const raw = ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'DA:3,0', 'end_of_record', ''].join('\n');
    const parsed = parseLcov(raw);
    expect(parsed.files[0]).toMatchObject({ covered: 2, total: 3 });
  });

  it('prefers LF/LH when the producer wrote them', () => {
    const raw = ['SF:src/a.ts', 'DA:1,1', 'LF:10', 'LH:7', 'end_of_record', ''].join('\n');
    expect(parsed(raw)).toMatchObject({ covered: 7, total: 10 });
    function parsed(text: string) {
      return parseLcov(text).files[0];
    }
  });

  it('keeps a final record with no end_of_record', () => {
    // A truncated report, but the file it names was still measured; dropping
    // it silently understates coverage.
    const raw = ['SF:src/a.ts', 'DA:1,1', 'DA:2,0', ''].join('\n');
    expect(parseLcov(raw).files).toHaveLength(1);
  });

  it('separates records for several files', () => {
    const raw = [
      'SF:src/a.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/b.ts',
      'DA:1,0',
      'end_of_record',
      '',
    ].join('\n');
    const parsed = parseLcov(raw);
    expect(parsed.files.map((f) => f.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed.pct).toBe(50);
  });
});

describe('parseCobertura', () => {
  it('counts hits per line where the report has them', () => {
    const xml = [
      '<coverage line-rate="0.5">',
      '<packages><package><classes>',
      '<class filename="src/a.ts" line-rate="0.5">',
      '<lines><line number="1" hits="3"/><line number="2" hits="0"/></lines>',
      '</class>',
      '</classes></package></packages></coverage>',
    ].join('');
    const parsed = parseCobertura(xml);
    expect(parsed.files[0]).toMatchObject({ file: 'src/a.ts', covered: 1, total: 2, pct: 50 });
  });

  it('falls back to line-rate with a zero denominator rather than inventing one', () => {
    // A percentage with no denominator cannot be re-aggregated; claiming a
    // count would make the roll-up wrong in a way nothing would catch.
    const xml = '<class filename="src/a.ts" line-rate="0.75"></class>';
    expect(parseCobertura(xml).files[0]).toMatchObject({ pct: 75, total: 0 });
  });
});

describe('parseCoverage dispatch', () => {
  it('routes by content', () => {
    expect(parseCoverage('<coverage></coverage>').format).toBe('cobertura');
    expect(parseCoverage('{"total":{"lines":{"total":1,"covered":1}}}').format).toBe(
      'istanbul-summary',
    );
    expect(parseCoverage('SF:a.ts\nend_of_record\n').format).toBe('lcov');
  });

  it('knows exactly three formats', () => {
    expect([...COVERAGE_FORMATS]).toEqual(['lcov', 'istanbul-summary', 'cobertura']);
  });
});

describe('coverageDelta', () => {
  const baseline = report([
    ['src/auth.ts', 90, 100],
    ['src/billing.ts', 80, 100],
  ]);

  it('passes when nothing lost coverage', () => {
    const delta = coverageDelta(
      report([
        ['src/auth.ts', 92, 100],
        ['src/billing.ts', 80, 100],
      ]),
      baseline,
    );
    expect(delta.ok).toBe(true);
    expect(delta.status).toBe('ok');
  });

  it('catches a per-file regression the total hides', () => {
    // The headline number *rises* while auth loses forty points. Averaging is
    // how coverage becomes a metric people report rather than one that catches
    // anything.
    const delta = coverageDelta(
      report([
        ['src/auth.ts', 50, 100],
        ['src/billing.ts', 100, 100],
        ['src/generated.ts', 1000, 1000],
      ]),
      baseline,
    );
    expect(delta.totalDeltaPp).toBeGreaterThan(0);
    expect(delta.ok).toBe(false);
    expect(delta.regressions).toEqual([{ file: 'src/auth.ts', before: 90, after: 50 }]);
  });

  it('treats the allowance as per file, not as a budget across the report', () => {
    // Ten files each losing a point is ten regressions. Spreading the loss
    // thinly is exactly how a total-based threshold is defeated.
    const wide = report(
      Array.from(
        { length: 10 },
        (_, i) => [`src/f${String(i)}.ts`, 90, 100] as [string, number, number],
      ),
    );
    const thinner = report(
      Array.from(
        { length: 10 },
        (_, i) => [`src/f${String(i)}.ts`, 87, 100] as [string, number, number],
      ),
    );
    const delta = coverageDelta(thinner, wide, 2);
    expect(delta.regressions).toHaveLength(10);
  });

  it('allows a drop inside the threshold', () => {
    const delta = coverageDelta(
      report([['src/auth.ts', 89, 100]]),
      report([['src/auth.ts', 90, 100]]),
      2,
    );
    expect(delta.ok).toBe(true);
  });

  it('does not treat a new file as a regression', () => {
    const delta = coverageDelta(
      report([
        ['src/auth.ts', 90, 100],
        ['src/billing.ts', 80, 100],
        ['src/new.ts', 10, 100],
      ]),
      baseline,
    );
    expect(delta.ok).toBe(true);
  });

  it('fails a file that vanished from the report', () => {
    // Excluding a file, renaming it, or deleting the only test that touched it
    // makes it stop regressing. The coverage of code nobody measures is not
    // known to be good.
    const delta = coverageDelta(report([['src/auth.ts', 90, 100]]), baseline);
    expect(delta.ok).toBe(false);
    expect(delta.dropped).toEqual(['src/billing.ts']);
  });

  it('reports `established`, not `ok`, when there is no baseline', () => {
    // Treating a missing baseline as fine makes deleting the baseline the
    // cheapest way through the gate.
    const delta = coverageDelta(report([['src/auth.ts', 90, 100]]), null);
    expect(delta.status).toBe('established');
    expect(delta.ok).toBe(false);
  });

  it('says plainly that no comparison happened', () => {
    const text = formatCoverageDelta(coverageDelta(report([['a.ts', 1, 1]]), null));
    expect(text).toContain('no baseline');
    expect(text).toContain('not a passing comparison');
  });

  it('names each regressed file with both numbers', () => {
    const text = formatCoverageDelta(
      coverageDelta(report([['src/auth.ts', 50, 100]]), report([['src/auth.ts', 90, 100]])),
    );
    expect(text).toContain('src/auth.ts: 90% → 50%');
    expect(text).toContain('Coverage regressed.');
  });
});

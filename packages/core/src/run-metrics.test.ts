import { describe, expect, it } from 'vitest';
import { RUN_FAILURE_REASONS, failureReasonFor } from './run-record.js';
import { runMetrics, runOutliers, type RunRow } from './run-metrics.js';

const row = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  workItemId: 'FEAT-001',
  skillId: 'implement',
  status: 'pass',
  failureReason: null,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  turns: null,
  startedAt: '2026-08-24T00:00:00.000Z',
  finishedAt: '2026-08-24T00:00:10.000Z',
  ...over,
});

describe('run metrics (P6-INSTRUMENT-02)', () => {
  it('reports no cost rather than zero cost', () => {
    // The rule the DORA report already follows. A project with no cost data and
    // one that spent nothing produce the same 0.00, and one of those is a
    // measurement while the other is an absence pretending to be one.
    const report = runMetrics([row(), row({ id: 'run-2' })]);
    expect(report.cost.totalUsd).toBeNull();
    expect(report.cost.inputTokens).toBeNull();
    expect(report.cost.runsWithUsage).toBe(0);
  });

  it('sums only the runs that reported usage, and says how many', () => {
    // A total over two of five runs is a floor, not a total, and the reader can
    // only know that if the denominator is printed beside it.
    const report = runMetrics([
      row({ id: 'a', costUsd: 0.5, inputTokens: 100 }),
      row({ id: 'b', costUsd: 0.25, inputTokens: 50 }),
      row({ id: 'c' }),
    ]);
    expect(report.cost.totalUsd).toBeCloseTo(0.75);
    expect(report.cost.inputTokens).toBe(150);
    expect(report.cost.runsWithUsage).toBe(2);
    expect(report.cost.runs).toBe(3);
  });

  it('keeps failed and errored apart', () => {
    // Work that failed is an ordinary outcome worth counting; a transport that
    // could not execute is an operational problem, and the fix for those two is
    // nothing alike.
    const report = runMetrics([
      row({ id: 'a', status: 'fail', failureReason: 'output-contract' }),
      row({ id: 'b', status: 'error', failureReason: 'transport' }),
    ]);
    const item = report.byWorkItem[0];
    expect(item?.failed).toBe(1);
    expect(item?.errored).toBe(1);
    expect(item?.passed).toBe(0);
  });

  it('counts over the whole failure vocabulary, not over what appeared', () => {
    // "No run has ever failed the output contract" is a different statement
    // from "that reason is not tracked", and only a total count says the first.
    const report = runMetrics([row({ status: 'fail', failureReason: 'timeout' })]);
    expect(report.failureReasons).toHaveLength(RUN_FAILURE_REASONS.length);
    expect(report.failureReasons.find((f) => f.reason === 'timeout')?.runs).toBe(1);
    expect(report.failureReasons.find((f) => f.reason === 'depth-cap')?.runs).toBe(0);
  });
});

describe('run outliers', () => {
  it('finds the card that took far more runs than the rest', () => {
    // The whole point of counting runs: a card at eleven attempts is a proxy for
    // a spec nobody could work from.
    const counts = [
      { key: 'FEAT-009', runs: 11, passed: 1, failed: 10, errored: 0 },
      { key: 'FEAT-001', runs: 2, passed: 2, failed: 0, errored: 0 },
      { key: 'FEAT-002', runs: 1, passed: 1, failed: 0, errored: 0 },
      { key: 'FEAT-003', runs: 2, passed: 2, failed: 0, errored: 0 },
    ];
    expect(runOutliers(counts).map((c) => c.key)).toEqual(['FEAT-009']);
  });

  it('uses the median, not the mean', () => {
    // A mean is dragged by the very outlier being looked for, so it raises the
    // threshold above the thing it is meant to catch. With runs of 5, 2, 2, 2:
    // the median is 2 and 5 clears 2× it, while the mean is 2.75 and 5 does not
    // clear 2× that. A mean-based rule reports nothing here.
    const counts = [
      { key: 'A', runs: 5, passed: 0, failed: 5, errored: 0 },
      { key: 'B', runs: 2, passed: 2, failed: 0, errored: 0 },
      { key: 'C', runs: 2, passed: 2, failed: 0, errored: 0 },
      { key: 'D', runs: 2, passed: 2, failed: 0, errored: 0 },
    ];
    expect(runOutliers(counts).map((c) => c.key)).toEqual(['A']);
  });

  it('says nothing with fewer than three cards', () => {
    // With two cards "unusual" is not a claim anything supports.
    expect(
      runOutliers([
        { key: 'A', runs: 9, passed: 0, failed: 9, errored: 0 },
        { key: 'B', runs: 1, passed: 1, failed: 0, errored: 0 },
      ]),
    ).toEqual([]);
  });

  it('flags nothing when every card took the same effort', () => {
    const same = ['A', 'B', 'C', 'D'].map((key) => ({
      key,
      runs: 3,
      passed: 3,
      failed: 0,
      errored: 0,
    }));
    expect(runOutliers(same)).toEqual([]);
  });
});

describe('failure classification', () => {
  it('separates a model that broke its contract from one that certified itself', () => {
    // Both are a schema rejection at the same boundary and they mean opposite
    // things. One is a prompt problem; the other is the thing this product
    // exists to prevent, and a single "invalid output" bucket hides it.
    expect(
      failureReasonFor({
        name: 'OutputContractError',
        message: 'output claims verification results (testsPassed) — the daemon runs verify',
      }),
    ).toBe('forbidden-claim');
    expect(failureReasonFor({ name: 'OutputContractError', message: 'no JSON object found' })).toBe(
      'output-contract',
    );
  });

  it('calls a timeout a timeout, not a transport failure', () => {
    // A timeout IS a transport failure; the more specific answer is the useful
    // one, and it is the one that tells you to raise the limit.
    expect(failureReasonFor(new Error('spawn ETIMEDOUT'))).toBe('timeout');
    expect(failureReasonFor(new Error('killed by SIGTERM'))).toBe('timeout');
  });

  it('recognises the recursion cap', () => {
    expect(failureReasonFor(new Error('depth 3 exceeds the cap of 2'))).toBe('depth-cap');
  });

  it('falls back to transport for anything it does not recognise', () => {
    // The default is the one that says "the target could not run", which is what
    // an unrecognised failure at this boundary almost always is.
    expect(failureReasonFor(new Error('ENOENT'))).toBe('transport');
    expect(failureReasonFor('a string')).toBe('transport');
  });
});

describe('cache hit rate (P6-INSTRUMENT-03)', () => {
  it('reports nothing when no run carried cache accounting', () => {
    // Distinct from a rate of zero. No run reporting and every run missing the
    // cache are different facts, and only one of them is a problem to fix.
    expect(runMetrics([row(), row({ id: 'b' })]).cache.hitRate).toBeNull();
  });

  it('divides by everything the provider had to take in', () => {
    // Dividing by fresh input alone makes a run that cached nothing report zero
    // AND a run that cached everything report infinity.
    const report = runMetrics([
      row({ id: 'a', inputTokens: 200, cacheReadTokens: 700, cacheCreationTokens: 100 }),
    ]);
    expect(report.cache.hitRate).toBeCloseTo(0.7);
    expect(report.cache.runsReporting).toBe(1);
  });

  it('reports a genuine zero when the cache was reported and never hit', () => {
    // The case the null is kept apart from: accounting arrived, and it said the
    // stable prefix is not stable.
    const report = runMetrics([
      row({ id: 'a', inputTokens: 900, cacheReadTokens: 0, cacheCreationTokens: 900 }),
    ]);
    expect(report.cache.hitRate).toBe(0);
  });
});

describe('trajectory (P6-INSTRUMENT-03)', () => {
  it('averages turns only over the runs that reported them', () => {
    // Counting a silent run as zero turns drags the average toward a number no
    // run actually had.
    const report = runMetrics([
      row({ id: 'a', turns: 6 }),
      row({ id: 'b', turns: 2 }),
      row({ id: 'c' }),
    ]);
    expect(report.trajectory.turns).toBe(8);
    expect(report.trajectory.turnsPerRun).toBe(4);
    expect(report.trajectory.runsReporting).toBe(2);
  });

  it('never reports turns as tool calls', () => {
    // FEAT-MET-013 asks for tool calls. `--output-format json` does not carry
    // them, and putting turns under that name would be a substitution nobody
    // could see in a dashboard.
    expect(runMetrics([row({ turns: 9 })]).trajectory.toolCalls).toBeNull();
  });
});

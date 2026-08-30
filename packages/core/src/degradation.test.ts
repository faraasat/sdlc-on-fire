import { describe, expect, it } from 'vitest';
import { accountRun, type TurnAccounting } from './context-horizon.js';
import {
  assessDegradation,
  DEGRADATION_SIGNALS,
  DEGRADATION_THRESHOLDS,
  formatDegradation,
} from './degradation.js';

const turns = (count: number, each = 1000): TurnAccounting[] =>
  Array.from({ length: count }, (_, i) => ({
    runId: 'run-1',
    turn: i + 1,
    inputTokens: each,
    outputTokens: 0,
  }));

const assess = (
  list: readonly TurnAccounting[],
  budgetTokens = 0,
  compactions = 0,
): ReturnType<typeof assessDegradation> =>
  assessDegradation({ account: accountRun('run-1', list), budgetTokens, compactions });

describe('unmeasured', () => {
  it('is its own state, not healthy', () => {
    const verdict = assess([]);
    expect(verdict.measured).toBe(false);
    expect(verdict.degraded).toBe(false);
    expect(verdict.because).toContain('not the same as nothing being wrong');
  });

  it('fires no tripwire, because nothing was watching', () => {
    expect(assess([], 100, 99).fired).toEqual([]);
  });
});

describe('over-budget', () => {
  it('fires past the declared ceiling', () => {
    const verdict = assess(turns(20), 10_000);
    expect(verdict.fired.map((f) => f.signal)).toContain('over-budget');
  });

  it('does not fire under it', () => {
    expect(assess(turns(5), 100_000).degraded).toBe(false);
  });

  it('does not fire at exactly the ceiling', () => {
    // Landing on the budget is landing inside it. Firing here would report a
    // run that stayed within what it declared.
    const verdict = assess(turns(10), 10_000);
    expect(verdict.fired.map((f) => f.signal)).not.toContain('over-budget');
  });

  it('fires one token over', () => {
    expect(assess(turns(10), 9_999).fired.map((f) => f.signal)).toContain('over-budget');
  });

  it('cannot fire with no ceiling declared', () => {
    // Nothing to be over. Firing anyway would make the signal depend on a
    // number nobody chose.
    expect(assess(turns(500)).fired.map((f) => f.signal)).not.toContain('over-budget');
  });

  it('names splitting the work, not raising the ceiling', () => {
    const over = assess(turns(20), 10_000).fired.find((f) => f.signal === 'over-budget');
    expect(over?.remedy).toContain('split');
  });
});

describe('repeatedly-compacted', () => {
  it('fires past the threshold', () => {
    const verdict = assess(turns(5), 1_000_000, DEGRADATION_THRESHOLDS.compactions + 1);
    expect(verdict.fired.map((f) => f.signal)).toContain('repeatedly-compacted');
  });

  it('does not fire at the threshold', () => {
    const verdict = assess(turns(5), 1_000_000, DEGRADATION_THRESHOLDS.compactions);
    expect(verdict.fired.map((f) => f.signal)).not.toContain('repeatedly-compacted');
  });

  it('says each firing is context the run no longer has', () => {
    const entry = assess(turns(5), 1_000_000, 9).fired.find(
      (f) => f.signal === 'repeatedly-compacted',
    );
    expect(entry?.remedy).toContain('no longer has');
  });
});

describe('accelerating', () => {
  it('fires when turns keep growing faster than the mean', () => {
    const growing: TurnAccounting[] = Array.from({ length: 6 }, (_, i) => ({
      runId: 'run-1',
      turn: i + 1,
      inputTokens: (i + 1) * 5000,
      outputTokens: 0,
    }));
    expect(assess(growing, 10_000_000).fired.map((f) => f.signal)).toContain('accelerating');
  });

  it('does not fire on a flat run', () => {
    expect(assess(turns(20), 10_000_000).fired.map((f) => f.signal)).not.toContain('accelerating');
  });

  it('does not fire on a run whose peak was early and has since settled', () => {
    // The distinction the signal turns on: a run that spiked at turn 2 and came
    // back down is not still growing. Reading the peak instead of the last turn
    // would flag it forever.
    const settled: TurnAccounting[] = [
      { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 0 },
      { runId: 'run-1', turn: 2, inputTokens: 90_000, outputTokens: 0 },
      { runId: 'run-1', turn: 3, inputTokens: 1000, outputTokens: 0 },
      { runId: 'run-1', turn: 4, inputTokens: 1000, outputTokens: 0 },
    ];
    expect(assess(settled, 10_000_000).fired.map((f) => f.signal)).not.toContain('accelerating');
  });

  it('cannot fire from a single turn — its size is its own mean', () => {
    expect(assess(turns(1), 10_000_000).fired).toEqual([]);
    expect(
      assess([{ runId: 'run-1', turn: 1, inputTokens: 999_999, outputTokens: 0 }], 0).fired,
    ).toEqual([]);
  });
});

describe('turn-count', () => {
  it('fires past the threshold', () => {
    const verdict = assess(turns(DEGRADATION_THRESHOLDS.turns + 1, 1), 10_000_000);
    expect(verdict.fired.map((f) => f.signal)).toContain('turn-count');
  });

  it('does not fire at the threshold', () => {
    const verdict = assess(turns(DEGRADATION_THRESHOLDS.turns, 1), 10_000_000);
    expect(verdict.fired.map((f) => f.signal)).not.toContain('turn-count');
  });
});

describe('evaluating all of them', () => {
  it('reports every tripwire, not just the first', () => {
    // Over budget *and* long is a different situation from either alone, and
    // short-circuiting would hide the difference behind whichever ran first.
    const verdict = assess(turns(50), 10_000, 9);
    const signals = verdict.fired.map((f) => f.signal);
    expect(signals).toContain('over-budget');
    expect(signals).toContain('turn-count');
    expect(signals).toContain('repeatedly-compacted');
  });

  it('reports a clean run as ok, with the numbers', () => {
    const verdict = assess(turns(5), 1_000_000);
    expect(verdict.degraded).toBe(false);
    expect(verdict.because).toContain('no tripwire fired');
  });

  it('only reports signals from the closed vocabulary', () => {
    for (const entry of assess(turns(50), 10_000, 9).fired) {
      expect(DEGRADATION_SIGNALS).toContain(entry.signal);
    }
  });

  it('gives every fired signal a remedy', () => {
    // A signal with no next step is an alarm nobody silences.
    for (const entry of assess(turns(50), 10_000, 9).fired) {
      expect(entry.remedy.length).toBeGreaterThan(20);
    }
  });
});

describe('formatDegradation', () => {
  it('distinguishes unmeasured from ok', () => {
    expect(formatDegradation(assess([]))).toContain('unmeasured');
    expect(formatDegradation(assess(turns(2), 1_000_000))).toContain('ok');
  });

  it('names each tripwire and its remedy', () => {
    const text = formatDegradation(assess(turns(50), 10_000));
    expect(text).toContain('over-budget');
    expect(text).toContain('split');
  });

  it('says why this is surfaced rather than inferred', () => {
    expect(formatDegradation(assess(turns(50), 10_000))).toContain('stays fluent');
  });
});

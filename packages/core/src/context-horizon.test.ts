import { describe, expect, it } from 'vitest';
import {
  accountRun,
  formatRunAccount,
  windowBlindnessRatio,
  type TurnAccounting,
} from './context-horizon.js';

const turn = (
  n: number,
  inputTokens: number,
  outputTokens = 100,
  cacheReadTokens?: number,
): TurnAccounting => ({
  runId: 'run-1',
  turn: n,
  inputTokens,
  outputTokens,
  ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
});

describe('accumulation', () => {
  it('is unmeasured with no turns, not zero-sized', () => {
    const account = accountRun('run-1', []);
    expect(account.turns).toBe(0);
    expect(account.perTurn).toBeNull();
    expect(account.growthPerTurn).toBeNull();
    expect(account.because).toContain('not small');
  });

  it('adds input and output across turns', () => {
    const account = accountRun('run-1', [turn(1, 1000, 100), turn(2, 2000, 200)]);
    expect(account.accumulatedInput).toBe(3000);
    expect(account.accumulatedOutput).toBe(300);
    expect(account.accumulated).toBe(3300);
  });

  it('counts cache reads as context the model took in', () => {
    // The discount is on the bill, not on the attention. Excluding them would
    // make a well-cached long run look like a short one.
    const account = accountRun('run-1', [turn(1, 100, 0, 50_000)]);
    expect(account.accumulatedInput).toBe(50_100);
    expect(account.cachedFraction).toBeCloseTo(0.998, 3);
  });

  it('tells the last turn from the peak turn', () => {
    // A run whose peak was turn 2 has settled down; one whose peak is the last
    // turn is still growing. Only the second is a degradation signal.
    const account = accountRun('run-1', [turn(1, 1000, 0), turn(2, 9000, 0), turn(3, 2000, 0)]);
    expect(account.peakTurn).toBe(9000);
    expect(account.lastTurn).toBe(2000);
  });

  it('has no last turn to report from an empty run', () => {
    expect(accountRun('run-1', []).lastTurn).toBe(0);
  });

  it('takes the last turn by number, not by arrival', () => {
    const account = accountRun('run-1', [turn(3, 3000, 0), turn(1, 1000, 0)]);
    expect(account.lastTurn).toBe(3000);
  });

  it('reports the peak window — what a per-window metric would have shown', () => {
    const account = accountRun('run-1', [turn(1, 1000), turn(2, 5000), turn(3, 2000)]);
    expect(account.peakTurn).toBe(5100);
  });

  it('counts cache reads toward the peak window too', () => {
    // `peakTurn` is what a per-window metric would have reported. A turn that
    // read 50k cached tokens filled a 50k window, whatever it cost.
    const account = accountRun('run-1', [turn(1, 1000, 0), turn(2, 100, 0, 50_000)]);
    expect(account.peakTurn).toBe(50_100);
  });

  it('counts cache reads toward the growth rate too', () => {
    const account = accountRun('run-1', [turn(1, 100, 0, 0), turn(2, 100, 0, 4000)]);
    expect(account.growthPerTurn).toBe(4000);
  });

  it('sorts by turn number, not by arrival', () => {
    // A retried turn arrives out of order, and a growth rate over a sequence
    // that never happened is worse than none.
    const account = accountRun('run-1', [turn(3, 3000), turn(1, 1000), turn(2, 2000)]);
    expect(account.growthPerTurn).toBe(1000);
  });
});

describe('growth', () => {
  it('is unmeasured from a single turn, not flat', () => {
    const account = accountRun('run-1', [turn(1, 1000)]);
    expect(account.growthPerTurn).toBeNull();
    expect(account.because).toContain('single point');
  });

  it('is tokens added per turn from first to last', () => {
    const account = accountRun('run-1', [turn(1, 1000), turn(2, 2000), turn(3, 3000)]);
    expect(account.growthPerTurn).toBe(1000);
  });

  it('goes negative when a run is shrinking', () => {
    expect(accountRun('run-1', [turn(1, 5000), turn(2, 1000)]).growthPerTurn).toBe(-4000);
  });

  it('divides by the gaps between turns, not the turn count', () => {
    // Two turns is one interval. Dividing by 2 would halve every growth rate.
    expect(accountRun('run-1', [turn(1, 0, 0), turn(2, 1000, 0)]).growthPerTurn).toBe(1000);
  });
});

describe('window blindness', () => {
  it('is 1 for a single-turn run — the window told the whole story', () => {
    expect(windowBlindnessRatio(accountRun('run-1', [turn(1, 1000)]))).toBe(1);
  });

  it('grows with the number of comparable turns', () => {
    const account = accountRun(
      'run-1',
      Array.from({ length: 10 }, (_, i) => turn(i + 1, 1000, 0)),
    );
    expect(windowBlindnessRatio(account)).toBe(10);
  });

  it('is null when there is nothing to compare', () => {
    expect(windowBlindnessRatio(accountRun('run-1', []))).toBeNull();
  });
});

describe('cachedFraction', () => {
  it('is null when nothing was read at all', () => {
    expect(accountRun('run-1', [turn(1, 0, 500)]).cachedFraction).toBeNull();
  });

  it('is zero when a provider reported no cache reads', () => {
    expect(accountRun('run-1', [turn(1, 1000)]).cachedFraction).toBe(0);
  });
});

describe('formatRunAccount', () => {
  it('says a run with no turns is unmeasured', () => {
    expect(formatRunAccount(accountRun('run-1', []))).toContain('unmeasured');
  });

  it('names the growth rate with a sign', () => {
    expect(formatRunAccount(accountRun('run-1', [turn(1, 1000), turn(2, 3000)]))).toContain(
      '+2000 tokens/turn',
    );
  });

  it('spells out how little a per-window metric saw of a long run', () => {
    const account = accountRun(
      'run-1',
      Array.from({ length: 20 }, (_, i) => turn(i + 1, 1000, 0)),
    );
    const text = formatRunAccount(account);
    expect(text).toContain('20× the largest window');
    expect(text).toContain('5%');
  });

  it('does not editorialise about blindness on a single-turn run', () => {
    expect(formatRunAccount(accountRun('run-1', [turn(1, 1000)]))).not.toContain('blind');
  });
});

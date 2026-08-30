import { describe, expect, it } from 'vitest';
import { accountRun, type TurnAccounting } from './context-horizon.js';
import {
  DEFAULT_COMPACT_AT,
  DEFAULT_RETAIN_RECENT,
  formatCompactionPlan,
  planCompaction,
} from './compaction.js';

const turns = (count: number, each = 1000): TurnAccounting[] =>
  Array.from({ length: count }, (_, i) => ({
    runId: 'run-1',
    turn: i + 1,
    inputTokens: each,
    outputTokens: 0,
  }));

const plan = (
  list: readonly TurnAccounting[],
  budget: number,
  options = {},
): ReturnType<typeof planCompaction> =>
  planCompaction(accountRun('run-1', list), list, budget, options);

describe('when it fires', () => {
  it('does not fire under the threshold', () => {
    // 10 turns × 1000 = 10_000, threshold at 80% of 20_000 is 16_000.
    const result = plan(turns(10), 20_000);
    expect(result.fired).toBe(false);
    expect(result.refusal).toBe('under-threshold');
  });

  it('fires at the threshold, not at the ceiling', () => {
    // Compacting exactly at the ceiling enforces the budget one turn after it
    // was exceeded — the turn that crossed it has already been sent.
    const result = plan(turns(20), 20_000);
    expect(result.thresholdTokens).toBe(16_000);
    expect(result.fired).toBe(true);
  });

  it('refuses with no declared budget rather than trimming toward nothing', () => {
    const result = plan(turns(50), 0);
    expect(result.fired).toBe(false);
    expect(result.refusal).toBe('no-budget');
    expect(result.reason).toContain('for its own sake');
  });

  it('refuses with no turns', () => {
    expect(plan([], 1000).refusal).toBe('no-turns');
  });

  it('returns a plan even when it will not fire, and says why', () => {
    // "Compaction did not happen" and "compaction was not needed" are
    // different facts, and returning nothing for both hides the first.
    const result = plan(turns(1), 20_000);
    expect(result.reason).not.toBe('');
    expect(result.retainedTurns).toEqual([1]);
  });
});

describe('what it keeps', () => {
  it('never drops the first turn — it carries the task', () => {
    const result = plan(turns(20), 5_000);
    expect(result.fired).toBe(true);
    expect(result.droppedTurns).not.toContain(1);
    expect(result.retainedTurns).toContain(1);
  });

  it('never drops the most recent turns', () => {
    const result = plan(turns(20), 5_000);
    for (const recent of [18, 19, 20]) {
      expect(result.droppedTurns).not.toContain(recent);
    }
  });

  it('honours a configured retention window', () => {
    const result = plan(turns(20), 5_000, { retainRecent: 6 });
    for (const recent of [15, 16, 17, 18, 19, 20]) {
      expect(result.droppedTurns).not.toContain(recent);
    }
  });

  it('refuses when everything is pinned, rather than pretending it helped', () => {
    // Four turns with a retention of three leaves nothing droppable. The honest
    // answer is that this run needs a smaller task, not a smaller context.
    const result = plan(turns(4, 10_000), 1_000);
    expect(result.fired).toBe(false);
    expect(result.refusal).toBe('nothing-droppable');
    expect(result.reason).toContain('smaller task');
  });

  it('keeps every turn it did not drop, listed', () => {
    const result = plan(turns(20), 5_000);
    const all = [...result.droppedTurns, ...result.retainedTurns].sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe('how much it drops', () => {
  it('drops oldest first', () => {
    const result = plan(turns(20), 5_000);
    expect(result.droppedTurns[0]).toBe(2);
    expect([...result.droppedTurns]).toEqual([...result.droppedTurns].sort((a, b) => a - b));
  });

  it('drops by turn number, not by arrival order', () => {
    // A retried turn arrives out of order. Trusting array order would drop
    // whichever turns happened to be recorded first, which is not the same set
    // as the oldest ones — and the plan would keep a turn it called recent.
    const shuffled = [...turns(20)].reverse();
    const result = planCompaction(accountRun('run-1', shuffled), shuffled, 5_000);
    expect(result.droppedTurns).not.toContain(1);
    for (const recent of [18, 19, 20]) expect(result.droppedTurns).not.toContain(recent);
    expect(result.droppedTurns[0]).toBe(2);
  });

  it('stops at the threshold rather than freeing everything it could', () => {
    // 20 turns × 1000 = 20_000; threshold 16_000; so it should free ~4_000,
    // not the 16_000 the droppable middle holds.
    const result = plan(turns(20), 20_000);
    expect(result.freedTokens).toBeGreaterThanOrEqual(4_000);
    expect(result.freedTokens).toBeLessThan(8_000);
    expect(result.accumulatedAfter).toBeLessThanOrEqual(result.thresholdTokens);
  });

  it('reports what remains, not just what went', () => {
    const result = plan(turns(20), 20_000);
    expect(result.accumulatedBefore).toBe(20_000);
    expect(result.accumulatedAfter).toBe(20_000 - result.freedTokens);
  });

  it('counts cache reads in what a dropped turn frees', () => {
    const list: TurnAccounting[] = [
      { runId: 'run-1', turn: 1, inputTokens: 100, outputTokens: 0 },
      { runId: 'run-1', turn: 2, inputTokens: 100, outputTokens: 0, cacheReadTokens: 50_000 },
      ...turns(4).map((t) => ({ ...t, turn: t.turn + 2 })),
    ];
    const result = planCompaction(accountRun('run-1', list), list, 10_000, { retainRecent: 2 });
    expect(result.droppedTurns).toContain(2);
    expect(result.freedTokens).toBeGreaterThanOrEqual(50_000);
  });
});

describe('the defaults', () => {
  it('fires before the ceiling', () => {
    expect(DEFAULT_COMPACT_AT).toBeLessThan(1);
  });

  it('keeps more than one recent turn', () => {
    expect(DEFAULT_RETAIN_RECENT).toBeGreaterThan(1);
  });
});

describe('formatCompactionPlan', () => {
  it('says why nothing happened', () => {
    expect(formatCompactionPlan(plan(turns(2), 100_000))).toContain('no compaction');
  });

  it('names both what went and what stayed', () => {
    const text = formatCompactionPlan(plan(turns(20), 5_000));
    expect(text).toContain('dropped turns:');
    expect(text).toContain('kept turns:');
  });

  it('says the record is the point', () => {
    expect(formatCompactionPlan(plan(turns(20), 5_000))).toContain('recorded, not discarded');
  });
});

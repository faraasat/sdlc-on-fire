import { describe, expect, it } from 'vitest';
import { backoffMs } from './realtime.js';
import { keysForTable, queryKeys } from './queries.js';

/**
 * P3-UI-01 — the pure parts of staying live.
 *
 * The socket itself is exercised end to end by the daemon's integration tests;
 * what is worth stating here is the arithmetic and the routing, both of which
 * are easy to get subtly wrong and impossible to notice in a running app.
 */

describe('backoffMs', () => {
  it('grows, so a dead daemon is not hammered', () => {
    expect(backoffMs(1)).toBe(500);
    expect(backoffMs(2)).toBe(1_000);
    expect(backoffMs(3)).toBe(2_000);
  });

  it('is capped, so a long outage does not become a long wait', () => {
    // Unbounded doubling means a daemon restarted after ten minutes is not
    // noticed for another ten.
    expect(backoffMs(20)).toBe(15_000);
    expect(backoffMs(100)).toBe(15_000);
  });

  it('never returns a negative or zero delay', () => {
    for (const attempt of [-5, 0, 1]) expect(backoffMs(attempt)).toBeGreaterThan(0);
  });
});

describe('keysForTable', () => {
  it('invalidates the list and the card for a work-item change', () => {
    const keys = keysForTable('work_items', 'FEAT-1');
    expect(keys).toContainEqual(queryKeys.workItems);
    expect(keys).toContainEqual(queryKeys.workItem('FEAT-1'));
  });

  it('invalidates the list for a run, because the card face carries the run chip', () => {
    // Slightly too eager costs a refetch; too narrow costs a stale board, and a
    // board that is quietly wrong is the failure being guarded against.
    expect(keysForTable('runs', 'r1')).toContainEqual(queryKeys.workItems);
    expect(keysForTable('gates', '1')).toContainEqual(queryKeys.workItems);
    expect(keysForTable('comments', '1')).toContainEqual(queryKeys.workItems);
  });

  it('invalidates nothing for a table the board does not render', () => {
    expect(keysForTable('embeddings', 'x')).toEqual([]);
  });
});

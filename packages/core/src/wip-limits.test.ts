import { describe, expect, it } from 'vitest';
import {
  checkWip,
  MIN_SAMPLE_FOR_WIP,
  wipLimitConfidence,
  wipLimitFor,
  wipLimits,
  type ColumnFlow,
} from './wip-limits.js';

/**
 * P3-KAN-05 — WIP limits derived rather than chosen.
 *
 * A limit nobody can justify is a limit somebody removes the first time it is
 * inconvenient. These assert the parts that make the derived number safe to act
 * on: it rounds in the forgiving direction, it refuses to speak from too few
 * samples, and "no limit" never renders as "you have room".
 */

const DAY = 86_400_000;
const flow = (over: Partial<ColumnFlow> = {}): ColumnFlow => ({
  column: 'In Progress',
  completed: 20,
  meanTimeInColumnMs: 4 * DAY,
  windowMs: 10 * DAY,
  ...over,
});

describe('wipLimitFor', () => {
  it('computes L = λW', () => {
    // 20 completions over 10 days is 2/day; 4 days in the column → 8.
    expect(wipLimitFor(flow()).limit).toBe(8);
  });

  it('rounds up, so a normal day does not trip the limit', () => {
    // A computed 2.3 rounded down to 2 makes the third card a violation on a
    // column that demonstrably handles 2.3 — and a limit that fires on normal
    // work is a limit people switch off.
    const limit = wipLimitFor(flow({ completed: 23, windowMs: 10 * DAY, meanTimeInColumnMs: DAY }));
    expect(limit.limit).toBe(3);
  });

  it('never derives a limit of zero', () => {
    // Zero would mean the column may never be used, which is never what the
    // data says.
    const limit = wipLimitFor(flow({ completed: 1, windowMs: 1000 * DAY, meanTimeInColumnMs: 1 }));
    expect(limit.limit).toBe(1);
  });

  it('refuses a number when nothing completed', () => {
    const limit = wipLimitFor(flow({ completed: 0 }));
    expect(limit.limit).toBeNull();
    expect(limit.confidence).toBe('none');
    expect(limit.because).toContain('no rate');
  });

  it('refuses a number when cards left instantly', () => {
    // W = 0 makes L = 0 for any arrival rate, which is arithmetic rather than
    // a statement about capacity.
    const limit = wipLimitFor(flow({ meanTimeInColumnMs: 0 }));
    expect(limit.limit).toBeNull();
    expect(limit.because).toContain('not measurable');
  });

  it('refuses a zero-length window rather than dividing by it', () => {
    expect(wipLimitFor(flow({ windowMs: 0 })).limit).toBeNull();
  });

  it('says plainly when the sample is too small to mean anything', () => {
    const limit = wipLimitFor(flow({ completed: 2 }));
    expect(limit.limit).not.toBeNull();
    expect(limit.confidence).toBe('weak');
    expect(limit.because).toContain('noise');
  });

  it('marks a real sample usable', () => {
    expect(wipLimitFor(flow({ completed: MIN_SAMPLE_FOR_WIP })).confidence).toBe('usable');
  });
});

describe('wipLimitConfidence', () => {
  it('grades by sample size', () => {
    expect(wipLimitConfidence(0)).toBe('none');
    expect(wipLimitConfidence(1)).toBe('weak');
    expect(wipLimitConfidence(MIN_SAMPLE_FOR_WIP - 1)).toBe('weak');
    expect(wipLimitConfidence(MIN_SAMPLE_FOR_WIP)).toBe('usable');
  });
});

describe('checkWip', () => {
  const limit = wipLimitFor(flow());

  it('grades under, at and over', () => {
    expect(checkWip('c', 7, limit).status).toBe('under');
    expect(checkWip('c', 8, limit).status).toBe('at');
    expect(checkWip('c', 9, limit).status).toBe('over');
  });

  it('says "unlimited", never "under", when no limit could be derived', () => {
    // Different facts: one means there is room, the other means nobody knows.
    // Rendering the second as the first is how a WIP limit becomes decoration.
    const none = wipLimitFor(flow({ completed: 0 }));
    expect(checkWip('c', 3, none).status).toBe('unlimited');
    expect(checkWip('c', 3, null).status).toBe('unlimited');
  });

  it('explains an over-limit column in terms of the constraint', () => {
    const check = checkWip('c', 20, limit);
    expect(check.because).toContain('downstream');
    expect(check.because).toContain('will not move it');
  });
});

describe('wipLimits', () => {
  it('derives one per column', () => {
    const limits = wipLimits([flow({ column: 'A' }), flow({ column: 'B', completed: 0 })]);
    expect(limits.map((entry) => [entry.column, entry.limit])).toEqual([
      ['A', 8],
      ['B', null],
    ]);
  });
});

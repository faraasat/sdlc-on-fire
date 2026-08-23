import { describe, expect, it } from 'vitest';
import { blockedTime, mergeSpans, type GateInterval } from './blocked-time.js';

const NOW = '2026-08-24T12:00:00.000Z';
const at = (hour: number): string => `2026-08-24T${String(hour).padStart(2, '0')}:00:00.000Z`;
const HOUR = 3_600_000;

const gate = (over: Partial<GateInterval> = {}): GateInterval => ({
  workItemId: 'FEAT-001',
  gateName: 'evidence',
  createdAt: at(1),
  resolvedAt: at(3),
  ...over,
});

describe('blocked time (P6-INSTRUMENT-03)', () => {
  it('merges overlapping gates rather than summing them', () => {
    // Two gates open at once for three hours is three hours of blocked time, not
    // six. The card was waiting the whole time and only once — summing per gate
    // reports a number larger than the elapsed life of the card, which is how a
    // metric stops being read.
    const [result] = blockedTime(
      [
        gate({ gateName: 'evidence', createdAt: at(1), resolvedAt: at(4) }),
        gate({ gateName: 'security', createdAt: at(2), resolvedAt: at(4) }),
      ],
      NOW,
    );
    expect(result?.blockedMs).toBe(3 * HOUR);
    expect(result?.episodes).toBe(1);
  });

  it('counts separated stretches as separate episodes', () => {
    const [result] = blockedTime(
      [
        gate({ createdAt: at(1), resolvedAt: at(2) }),
        gate({ gateName: 'security', createdAt: at(5), resolvedAt: at(6) }),
      ],
      NOW,
    );
    expect(result?.blockedMs).toBe(2 * HOUR);
    expect(result?.episodes).toBe(2);
  });

  it('treats a gate raised the moment another cleared as one uninterrupted wait', () => {
    // Reporting two adjacent episodes describes a moment of relief that did not
    // happen.
    const [result] = blockedTime(
      [
        gate({ createdAt: at(1), resolvedAt: at(3) }),
        gate({ gateName: 'security', createdAt: at(3), resolvedAt: at(5) }),
      ],
      NOW,
    );
    expect(result?.episodes).toBe(1);
    expect(result?.blockedMs).toBe(4 * HOUR);
  });

  it('measures an unresolved gate to now, and says the total is still growing', () => {
    // A card blocked for three weeks and never resolved is the one worth seeing.
    // Skipping open gates would report it as never having been blocked at all.
    const [result] = blockedTime([gate({ createdAt: at(9), resolvedAt: null })], NOW);
    expect(result?.blockedMs).toBe(3 * HOUR);
    expect(result?.stillBlocked).toBe(true);
  });

  it('marks a fully resolved card as no longer blocked', () => {
    const [result] = blockedTime([gate()], NOW);
    expect(result?.stillBlocked).toBe(false);
    expect(result?.blockedMs).toBe(2 * HOUR);
  });

  it('keeps work items apart and sorts the worst first', () => {
    const results = blockedTime(
      [
        gate({ workItemId: 'FEAT-001', createdAt: at(1), resolvedAt: at(2) }),
        gate({ workItemId: 'FEAT-002', createdAt: at(1), resolvedAt: at(6) }),
      ],
      NOW,
    );
    expect(results.map((r) => r.workItemId)).toEqual(['FEAT-002', 'FEAT-001']);
  });

  it('ignores a gate whose timestamps cannot be read', () => {
    // Garbage in a timestamp column produces NaN arithmetic, and NaN milliseconds
    // renders as "NaNh" beside real numbers rather than as an error anyone chases.
    const [result] = blockedTime(
      [
        gate({ createdAt: 'not a date' }),
        gate({ gateName: 'x', createdAt: at(1), resolvedAt: at(2) }),
      ],
      NOW,
    );
    expect(result?.blockedMs).toBe(HOUR);
  });

  it('ignores a gate resolved before it was raised', () => {
    // Clock skew between writers is real, and a negative span would subtract
    // from a total that is meant to only ever grow.
    expect(blockedTime([gate({ createdAt: at(5), resolvedAt: at(2) })], NOW)[0]?.blockedMs).toBe(0);
  });
});

describe('mergeSpans', () => {
  it('leaves disjoint spans alone', () => {
    expect(
      mergeSpans([
        { start: 0, end: 1 },
        { start: 5, end: 6 },
      ]),
    ).toHaveLength(2);
  });

  it('merges regardless of input order', () => {
    expect(
      mergeSpans([
        { start: 5, end: 9 },
        { start: 0, end: 6 },
      ]),
    ).toEqual([{ start: 0, end: 9 }]);
  });

  it('swallows a span entirely inside another', () => {
    // Taking the later `end` unconditionally would shorten the outer span.
    expect(
      mergeSpans([
        { start: 0, end: 10 },
        { start: 2, end: 3 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

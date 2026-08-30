import { describe, expect, it } from 'vitest';
import {
  formatHeldOutTrend,
  heldOutTrend,
  TREND_DIRECTIONS,
  TREND_NOISE_PP,
  type HeldOutSample,
} from './held-out-trend.js';

const sample = (deltaPp: number | null, day: number): HeldOutSample => ({
  workItemId: 'TASK-001',
  measuredAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  visiblePassed: 8,
  visibleTotal: 10,
  heldOutPassed: 5,
  heldOutTotal: 10,
  deltaPp,
});

describe('heldOutTrend', () => {
  it('is unmeasured with nothing to go on', () => {
    const trend = heldOutTrend([]);
    expect(trend.direction).toBe('unmeasured');
    expect(trend.changePp).toBeNull();
    expect(trend.because).toContain('not the same as small');
  });

  it('is unmeasured with a single point, not stable', () => {
    // The reassuring answer would be "stable". A single point has no direction.
    const trend = heldOutTrend([sample(10, 1)]);
    expect(trend.direction).toBe('unmeasured');
    expect(trend.because).toContain('single point');
  });

  it('calls a growing gap widening', () => {
    const trend = heldOutTrend([sample(5, 1), sample(20, 2)]);
    expect(trend.direction).toBe('widening');
    expect(trend.changePp).toBe(15);
  });

  it('calls a shrinking gap narrowing', () => {
    const trend = heldOutTrend([sample(20, 1), sample(5, 2)]);
    expect(trend.direction).toBe('narrowing');
    expect(trend.changePp).toBe(-15);
  });

  it('calls movement under the noise floor flat', () => {
    // One criterion flipping on a fifty-item set moves the delta 2pp. Without a
    // floor every ordinary run reports a direction and the signal stops being one.
    const trend = heldOutTrend([sample(10, 1), sample(11, 2)]);
    expect(trend.direction).toBe('flat');
    expect(Math.abs(trend.changePp ?? 0)).toBeLessThan(TREND_NOISE_PP);
  });

  it('treats exactly the noise floor as a trend, not as noise', () => {
    expect(heldOutTrend([sample(10, 1), sample(10 + TREND_NOISE_PP, 2)]).direction).toBe(
      'widening',
    );
  });

  it('drops unmeasured samples rather than counting them as zero', () => {
    // Folding a null in as 0 would drag every trend toward "narrowing" on
    // exactly the projects that have not started measuring.
    const trend = heldOutTrend([sample(20, 1), sample(null, 2), sample(30, 3)]);
    expect(trend.direction).toBe('widening');
    expect(trend.measuredSamples).toBe(2);
    expect(trend.changePp).toBe(10);
  });

  it('is unmeasured when only nulls were recorded', () => {
    expect(heldOutTrend([sample(null, 1), sample(null, 2)]).direction).toBe('unmeasured');
  });

  it('orders by time, not by array order', () => {
    const trend = heldOutTrend([sample(30, 3), sample(10, 1)]);
    expect(trend.first?.deltaPp).toBe(10);
    expect(trend.latest?.deltaPp).toBe(30);
    expect(trend.direction).toBe('widening');
  });

  it('compares first against latest, not the last two', () => {
    // A gap that dipped and recovered has not improved.
    const trend = heldOutTrend([sample(5, 1), sample(40, 2), sample(30, 3)]);
    expect(trend.direction).toBe('widening');
    expect(trend.changePp).toBe(25);
  });

  it('reports a direction from the closed vocabulary', () => {
    expect(TREND_DIRECTIONS).toContain(heldOutTrend([sample(1, 1), sample(9, 2)]).direction);
  });
});

describe('formatHeldOutTrend', () => {
  it('says why nothing can be said', () => {
    expect(formatHeldOutTrend(heldOutTrend([]))).toContain('unmeasured');
  });

  it('signs the movement', () => {
    expect(formatHeldOutTrend(heldOutTrend([sample(5, 1), sample(20, 2)]))).toContain('+15pp');
  });

  it('spells out what a widening gap means, since that is the actionable case', () => {
    const text = formatHeldOutTrend(heldOutTrend([sample(5, 1), sample(20, 2)]));
    expect(text).toContain('fixing the');
  });

  it('does not editorialise on a narrowing one', () => {
    expect(formatHeldOutTrend(heldOutTrend([sample(20, 1), sample(5, 2)]))).not.toContain(
      'scoreboard',
    );
  });
});

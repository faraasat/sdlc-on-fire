import { describe, expect, it } from 'vitest';
import { wilson } from './visibility-analysis.js';
import {
  formatVisibilityTrend,
  intervalsDisjoint,
  TREND_VERDICTS,
  visibilityTrend,
  VISIBILITY_LEVELS,
  type VisibilitySnapshot,
} from './visibility-trend.js';

const snapshot = (day: number, mentionHits: number, attempts = 40): VisibilitySnapshot => ({
  at: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  subject: 'SDLC on Fire',
  host: 'sdlc-on-fire.dev',
  answered: wilson(attempts, attempts),
  mention: wilson(mentionHits, attempts),
  citation: wilson(0, attempts),
  failures: 0,
});

describe('intervalsDisjoint', () => {
  it('is false for overlapping intervals', () => {
    expect(intervalsDisjoint(wilson(20, 40), wilson(22, 40))).toBe(false);
  });

  it('is true when they do not touch', () => {
    expect(intervalsDisjoint(wilson(2, 100), wilson(90, 100))).toBe(true);
  });

  it('does not care which side is which', () => {
    expect(intervalsDisjoint(wilson(90, 100), wilson(2, 100))).toBe(true);
  });

  it('treats exactly-touching intervals as overlapping', () => {
    // The conservative reading: intervals that meet at a point have not been
    // shown to differ. Real Wilson bounds will essentially never land here, and
    // the boundary is asserted anyway because "essentially never" is the kind
    // of assumption that decides a stakeholder-facing number once.
    const a = { value: 0.2, low: 0.1, high: 0.3, hits: 20, attempts: 100 };
    const b = { value: 0.4, low: 0.3, high: 0.5, hits: 40, attempts: 100 };
    expect(intervalsDisjoint(a, b)).toBe(false);
    expect(intervalsDisjoint(b, a)).toBe(false);
  });
});

describe('visibilityTrend', () => {
  it('is unmeasured with nothing recorded', () => {
    const trend = visibilityTrend([]);
    expect(trend.snapshots).toBe(0);
    expect(trend.levels.every((level) => level.verdict === 'unmeasured')).toBe(true);
    expect(trend.because).toContain('no visibility runs');
  });

  it('is unmeasured from one run — a single point is not a trend', () => {
    const trend = visibilityTrend([snapshot(1, 20)]);
    expect(trend.snapshots).toBe(1);
    expect(trend.levels.every((level) => level.verdict === 'unmeasured')).toBe(true);
    expect(trend.because).toContain('one point is not one');
  });

  it('calls a small move indistinguishable rather than picking a direction', () => {
    // 20/40 vs 22/40 is a 5pp point-estimate move well inside what the same
    // conditions produce twice. A point-estimate trend would draw a line here.
    const trend = visibilityTrend([snapshot(1, 20), snapshot(2, 22)]);
    const mention = trend.levels.find((level) => level.level === 'mention');
    expect(mention?.verdict).toBe('indistinguishable');
    expect(mention?.changePp).toBe(5);
    expect(trend.moved).toEqual([]);
  });

  it('still reports the point-estimate change it declined to act on', () => {
    const mention = visibilityTrend([snapshot(1, 20), snapshot(2, 22)]).levels.find(
      (level) => level.level === 'mention',
    );
    expect(mention?.changePp).toBe(5);
    expect(mention?.because).toContain('does not support');
  });

  it('calls a large move improved when the intervals separate', () => {
    const trend = visibilityTrend([snapshot(1, 2, 100), snapshot(2, 90, 100)]);
    const mention = trend.levels.find((level) => level.level === 'mention');
    expect(mention?.verdict).toBe('improved');
    expect(trend.moved).toContain('mention');
  });

  it('calls the reverse declined', () => {
    const trend = visibilityTrend([snapshot(1, 90, 100), snapshot(2, 2, 100)]);
    expect(trend.levels.find((l) => l.level === 'mention')?.verdict).toBe('declined');
  });

  it('compares first against latest, not the last two', () => {
    // A rate that dipped and recovered has not improved.
    const trend = visibilityTrend([
      snapshot(1, 90, 100),
      snapshot(2, 2, 100),
      snapshot(3, 88, 100),
    ]);
    expect(trend.levels.find((l) => l.level === 'mention')?.verdict).toBe('indistinguishable');
  });

  it('orders by time, not by array order', () => {
    const trend = visibilityTrend([snapshot(3, 90, 100), snapshot(1, 2, 100)]);
    expect(trend.levels.find((l) => l.level === 'mention')?.first?.hits).toBe(2);
    expect(trend.levels.find((l) => l.level === 'mention')?.verdict).toBe('improved');
  });

  it('reports every level, whether or not it moved', () => {
    const trend = visibilityTrend([snapshot(1, 2, 100), snapshot(2, 90, 100)]);
    expect(trend.levels.map((l) => l.level)).toEqual([...VISIBILITY_LEVELS]);
  });

  it('only uses verdicts from the closed vocabulary', () => {
    for (const level of visibilityTrend([snapshot(1, 20), snapshot(2, 22)]).levels) {
      expect(TREND_VERDICTS).toContain(level.verdict);
    }
  });

  it('carries the subject through', () => {
    expect(visibilityTrend([snapshot(1, 20)]).subject).toBe('SDLC on Fire');
  });
});

describe('formatVisibilityTrend', () => {
  it('says when there is nothing', () => {
    expect(formatVisibilityTrend(visibilityTrend([]))).toContain('no visibility runs');
  });

  it('shows counts and intervals, never a bare rate', () => {
    const text = formatVisibilityTrend(visibilityTrend([snapshot(1, 20), snapshot(2, 22)]));
    expect(text).toContain('(20/40)');
    expect(text).toMatch(/\[\d+\.\d–\d+\.\d\]/);
  });

  it('explains why "no change" is the honest outcome', () => {
    const text = formatVisibilityTrend(visibilityTrend([snapshot(1, 20), snapshot(2, 22)]));
    expect(text).toContain('sampling');
  });

  it('does not lecture when something did move', () => {
    const text = formatVisibilityTrend(
      visibilityTrend([snapshot(1, 2, 100), snapshot(2, 90, 100)]),
    );
    expect(text).not.toContain('sampling');
  });
});

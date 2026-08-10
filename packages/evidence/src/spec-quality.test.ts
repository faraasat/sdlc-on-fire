import { describe, expect, it } from 'vitest';
import { formatSpecQuality, QUALITY_WEIGHTS, scoreSpecQuality } from './spec-quality.js';
import { isScoredCriterion } from './definition-of-ready.js';

/** P1-OBJ-07 — the observed quality score (FEAT-OBJ-020). */

const good = {
  workItemId: 'FEAT-001',
  acceptanceCriteria: [
    'The importer MUST retry three times.',
    'GIVEN a bad row WHEN parsed THEN the row is skipped',
    'Errors SHOULD be logged with the row number.',
  ],
  nonGoals: ['multi-currency'],
  coverage: [
    { acId: 'The importer MUST retry three times.', edges: 2, hasEvidence: true },
    { acId: 'GIVEN a bad row WHEN parsed THEN the row is skipped', edges: 1, hasEvidence: true },
    { acId: 'Errors SHOULD be logged with the row number.', edges: 1, hasEvidence: true },
  ],
};

describe('scoreSpecQuality', () => {
  it('scores a well-formed, fully traced spec at the top', () => {
    expect(scoreSpecQuality(good).score).toBe(100);
  });

  it('separates "nothing to score" from "scored badly"', () => {
    const empty = scoreSpecQuality({ ...good, acceptanceCriteria: [], coverage: [] });
    // A dashboard that shows 0 for a card nobody has specified yet teaches
    // people to distrust it.
    expect(empty.insufficientData).toBe(true);
    expect(formatSpecQuality(empty)).toContain('not enough to score yet');
  });

  it('does not reward padding the criteria list', () => {
    const padded = scoreSpecQuality({
      ...good,
      acceptanceCriteria: [...good.acceptanceCriteria, ...good.acceptanceCriteria],
    });
    const three = scoreSpecQuality({ ...good, coverage: good.coverage });
    // Twelve criteria are not four times better specified than three, and a
    // linear count is exactly what a scored metric gets gamed on.
    expect(padded.sub.find((entry) => entry.name === 'ac-presence')?.value).toBe(1);
    expect(three.sub.find((entry) => entry.name === 'ac-presence')?.value).toBe(1);
  });

  it('measures traceability against the criteria, not against the edges that exist', () => {
    const partial = scoreSpecQuality({
      ...good,
      coverage: [{ acId: good.acceptanceCriteria[0] ?? '', edges: 1, hasEvidence: true }],
    });
    // Dividing by the edge count would score one linked criterion out of three
    // as fully covered.
    expect(partial.sub.find((entry) => entry.name === 'traceability')?.value).toBeCloseTo(1 / 3);
  });

  it('does not count a criterion linked to code nobody proved anything about', () => {
    const unproven = scoreSpecQuality({
      ...good,
      coverage: good.coverage.map((row) => ({ ...row, hasEvidence: false })),
    });
    expect(unproven.sub.find((entry) => entry.name === 'traceability')?.value).toBe(0);
  });

  it('penalises criteria that state a wish', () => {
    const vague = scoreSpecQuality({
      ...good,
      acceptanceCriteria: ['it should probably work', 'and be fast'],
      coverage: [],
    });
    expect(vague.sub.find((entry) => entry.name === 'ac-scored')?.value).toBe(0);
    expect(vague.score).toBeLessThan(50);
  });

  it('shares its criterion scoring with the Definition-of-Ready gate', () => {
    // Two implementations of "is this criterion well-formed" would disagree
    // eventually, and the disagreement shows up as a card the dashboard calls
    // good and the gate refuses.
    for (const text of good.acceptanceCriteria) expect(isScoredCriterion(text)).toBe(true);
  });

  it('has weights that sum to one', () => {
    const total = Object.values(QUALITY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1);
  });
});

describe('formatSpecQuality', () => {
  it('says plainly that the number does not gate', () => {
    // Someone will ask, and the answer belongs next to the number rather than
    // in a document nobody opens.
    expect(formatSpecQuality(scoreSpecQuality(good))).toContain('observed, not enforced');
  });
});

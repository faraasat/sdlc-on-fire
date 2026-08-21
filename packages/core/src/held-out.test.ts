import { describe, expect, it } from 'vitest';
import {
  admitHeldOut,
  expectedGapPp,
  formatHeldOutDelta,
  heldOutDelta,
  HELD_OUT_REDACTION,
  summariseHeldOut,
  type HeldOutCriterion,
} from './held-out.js';

/** P3-GATE-09 — the delta that was uncomputable. */

const criterion = (over: Partial<HeldOutCriterion> = {}): HeldOutCriterion => ({
  id: '1',
  workItemId: 'FEAT-001',
  text: 'importing a 10MB CSV does not exhaust memory',
  authorActorId: 'reviewer',
  createdAt: '2026-08-21T00:00:00Z',
  ...over,
});

const admit = (over: Record<string, unknown> = {}) =>
  admitHeldOut({
    text: 'importing a 10MB CSV does not exhaust memory',
    authorActorId: 'reviewer',
    implementerActorId: 'author',
    visibleCriteria: ['the CSV parser handles quoted commas'],
    ...over,
  });

describe('a different actor, and it is not overridable', () => {
  it('admits a criterion from somebody else', () => {
    expect(admit().admitted).toBe(true);
  });

  it('refuses one written by the implementer', () => {
    // The whole check. A criterion written by the actor implementing against it
    // is held out from nobody.
    const verdict = admit({ authorActorId: 'author' });
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toBe('same-author');
    expect(verdict.because).toContain('ADR-0037');
  });

  it('admits when nobody has claimed the item yet', () => {
    // No implementer means nothing to be the same as. Refusing here would make
    // held-out criteria impossible to write before work starts, which is the
    // only sensible time to write them.
    expect(admit({ implementerActorId: null, authorActorId: 'anyone' }).admitted).toBe(true);
  });

  it('refuses an unattributed criterion', () => {
    expect(admit({ authorActorId: '  ' }).refusal).toBe('no-author');
  });

  it('refuses empty text', () => {
    expect(admit({ text: '   ' }).refusal).toBe('empty-text');
  });
});

describe('it must not restate the visible set', () => {
  it('refuses a copy of a visible criterion', () => {
    // The cheapest way to make the delta look good: copy the visible criteria
    // across, and Δ is zero by construction.
    const verdict = admit({ text: 'The CSV parser handles quoted commas.' });
    expect(verdict.refusal).toBe('restates-visible');
    expect(verdict.because).toContain('zero by construction');
  });

  it('sees through casing, punctuation and filler', () => {
    expect(admit({ text: 'the CSV parser handles the quoted commas!!' }).refusal).toBe(
      'restates-visible',
    );
  });

  it('admits a genuinely different criterion about the same subject', () => {
    // Held-out criteria compose what the spec already says into realistic use;
    // "different subject" is not the bar and would be the wrong one.
    expect(admit({ text: 'a CSV with quoted commas round-trips through export' }).admitted).toBe(
      true,
    );
  });
});

describe('the text never leaves the store', () => {
  it('summarises to a count and a redaction, with no field for the text', () => {
    const summary = summariseHeldOut('FEAT-001', [criterion(), criterion({ id: '2' })]);
    expect(summary.count).toBe(2);
    expect(summary.redaction).toBe(HELD_OUT_REDACTION);
    expect(JSON.stringify(summary)).not.toContain('10MB');
  });

  it('says the count even when it is zero, because that is the finding', () => {
    expect(summariseHeldOut('FEAT-001', []).count).toBe(0);
  });
});

describe('the delta', () => {
  const pass = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `p${String(i)}`, passed: true }));
  const fail = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `f${String(i)}`, passed: false }));

  it('is zero when both sides agree', () => {
    expect(heldOutDelta(pass(4), pass(2)).deltaPp).toBe(0);
  });

  it('is positive when the visible set passes more often', () => {
    // 100% visible, 50% held-out.
    expect(heldOutDelta(pass(4), [...pass(1), ...fail(1)]).deltaPp).toBe(50);
  });

  it('is negative when the held-out set does better', () => {
    expect(heldOutDelta([...pass(1), ...fail(1)], pass(2)).deltaPp).toBe(-50);
  });

  it('is null — not zero — when there are no held-out criteria', () => {
    // The distinction that matters: "the held-out suite agrees" and "nobody
    // wrote any" look identical in anything that defaults to zero, and the
    // second is the state every project starts in.
    const delta = heldOutDelta(pass(4), []);
    expect(delta.deltaPp).toBeNull();
    expect(delta.because).toContain('unmeasured');
  });

  it('is null when there is nothing visible to compare against', () => {
    expect(heldOutDelta([], pass(2)).deltaPp).toBeNull();
  });

  it('reports both raw counts, not only the rate', () => {
    const delta = heldOutDelta([...pass(3), ...fail(1)], [...pass(1), ...fail(1)]);
    expect(delta.visiblePassed).toBe(3);
    expect(delta.visibleTotal).toBe(4);
    expect(delta.heldOutPassed).toBe(1);
    expect(delta.heldOutTotal).toBe(2);
  });

  it('prints the unmeasured case as unmeasured', () => {
    expect(formatHeldOutDelta(heldOutDelta(pass(1), []))).toContain('Δ unmeasured');
  });
});

describe('the expected gap for a change of this size', () => {
  it('expects nothing for a small change', () => {
    expect(expectedGapPp(300)).toBe(0);
    expect(expectedGapPp(1_000)).toBe(0);
  });

  it('expects roughly 27pp per tenfold increase', () => {
    expect(expectedGapPp(10_000)).toBeCloseTo(27, 0);
    expect(expectedGapPp(100_000)).toBeCloseTo(54, 0);
  });

  it('never exceeds 100 percentage points', () => {
    // A rate difference cannot, so neither may the prediction.
    expect(expectedGapPp(10_000_000_000)).toBeLessThanOrEqual(100);
  });

  it('is monotonic in change size', () => {
    expect(expectedGapPp(50_000)).toBeGreaterThan(expectedGapPp(5_000));
  });
});

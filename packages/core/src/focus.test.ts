import { describe, expect, it } from 'vitest';
import {
  BASELINE_CHECKS,
  explainRequiredChecks,
  focusedDimensions,
  FocusProfileSchema,
  requiredChecksFor,
} from './focus.js';

/**
 * Focus-weighted rigor (P1-LIFE-06, ADR-0054).
 *
 * The whole feature has one way to go badly wrong: if focus *selects* the
 * required checks rather than adding to them, then a declaration the project
 * writes about itself becomes a legitimate-looking way to switch the tests off.
 * Most of this file is about that.
 */

const profile = (weights: Record<string, number>) => FocusProfileSchema.parse({ weights });

describe('what counts as in focus', () => {
  it('takes a dimension at or above the threshold', () => {
    expect(focusedDimensions(profile({ security: 0.5 }))).toEqual(['security']);
    expect(focusedDimensions(profile({ security: 0.49 }))).toEqual([]);
  });

  it('treats an undeclared project as focused on nothing', () => {
    // Inferring a focus from the code would be a model judgement in a decision
    // path, which ADR-0040 rules out — and the floors mean declaring nothing is
    // never the unsafe choice.
    expect(focusedDimensions(FocusProfileSchema.parse({}))).toEqual([]);
  });

  it('reports dimensions in a stable order', () => {
    const one = focusedDimensions(profile({ ui: 1, security: 1 }));
    const two = focusedDimensions(profile({ security: 1, ui: 1 }));
    expect(one).toEqual(two);
  });
});

describe('the floor holds', () => {
  it('requires the baseline with no focus declared at all', () => {
    expect(requiredChecksFor(FocusProfileSchema.parse({}))).toEqual([...BASELINE_CHECKS]);
  });

  it('cannot be lowered by declaring a focus elsewhere', () => {
    // The attack this file exists to prevent: `focus: ui` must not be a way to
    // stop needing the tests to pass.
    const required = requiredChecksFor(profile({ ui: 1 }));
    for (const kind of BASELINE_CHECKS) expect(required).toContain(kind);
  });

  it('cannot be lowered by declaring every dimension irrelevant', () => {
    const required = requiredChecksFor(
      profile({ ui: 0, security: 0, correctness: 0, performance: 0 }),
    );
    for (const kind of BASELINE_CHECKS) expect(required).toContain(kind);
  });

  it('is a union, so more focus never means fewer checks', () => {
    // Stated as a property rather than an example: any focus is a superset of no
    // focus. If this ever fails, focus has become a selector.
    const none = requiredChecksFor(FocusProfileSchema.parse({}));
    for (const dimension of ['ui', 'security', 'data-integrity', 'correctness'] as const) {
      const withFocus = requiredChecksFor(profile({ [dimension]: 1 }));
      for (const kind of none) expect(withFocus, dimension).toContain(kind);
    }
  });
});

describe('focus adds required evidence', () => {
  it('adds the security set when security is in focus', () => {
    expect(requiredChecksFor(profile({ security: 0.9 }))).toContain('security-scan');
    expect(requiredChecksFor(FocusProfileSchema.parse({}))).not.toContain('security-scan');
  });

  it('adds the UI set when UI is in focus', () => {
    expect(requiredChecksFor(profile({ ui: 0.8 }))).toContain('e2e');
  });

  it('combines two focuses without double-counting', () => {
    const required = requiredChecksFor(profile({ security: 1, correctness: 1 }));
    expect(new Set(required).size).toBe(required.length);
    expect(required).toContain('security-scan');
    expect(required).toContain('mutation-score');
  });

  it('orders the result canonically, so two callers agree exactly', () => {
    expect(requiredChecksFor(profile({ security: 1, ui: 1 }))).toEqual(
      requiredChecksFor(profile({ ui: 1, security: 1 })),
    );
  });
});

describe('why each check is required', () => {
  it('attributes baseline checks to the baseline, not to a declaration', () => {
    // Nobody can tell whether lowering the declaration would remove a check
    // unless the required set says where each one came from.
    const explained = explainRequiredChecks(profile({ ui: 1 }));
    expect(explained.filter((entry) => entry.kind === 'test')[0]?.dimension).toBe('(baseline)');
    expect(explained.find((entry) => entry.kind === 'e2e')?.dimension).toBe('ui');
  });

  it('explains exactly the set it requires', () => {
    const required = requiredChecksFor(profile({ security: 1 }));
    const explained = new Set(explainRequiredChecks(profile({ security: 1 })).map((e) => e.kind));
    expect([...explained].sort()).toEqual([...required].sort());
  });
});

describe('the profile itself', () => {
  it('rejects a dimension outside the vocabulary', () => {
    expect(FocusProfileSchema.safeParse({ weights: { vibes: 1 } }).success).toBe(false);
  });

  it('rejects a weight outside 0..1', () => {
    expect(FocusProfileSchema.safeParse({ weights: { ui: 5 } }).success).toBe(false);
  });

  it('does not normalise weights, so raising one cannot lower another', () => {
    const parsed = profile({ ui: 1, security: 1 });
    expect(parsed.weights.ui).toBe(1);
    expect(parsed.weights.security).toBe(1);
  });
});

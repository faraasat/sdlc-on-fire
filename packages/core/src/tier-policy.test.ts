import { describe, expect, it } from 'vitest';
import {
  exceedsCeiling,
  ModelPostureSchema,
  undeclaredModels,
  carriesVersion,
  loadTierPolicy,
  TierPolicyError,
  tierPolicyViolations,
  TierPolicyConfigSchema,
} from './tier-policy.js';

/**
 * The tier policy as configuration (P1-AGENT-08).
 *
 * `TierPolicy` was a type nothing ever built from a file, so ADR-0028's rule
 * that a model id appears in exactly one place held for the type and not for the
 * system: every caller passed its own literal.
 */

const VALID = {
  models: {
    low: 'claude-haiku-4-5-20251001',
    medium: 'claude-sonnet-4-5-20250929',
    high: 'claude-opus-4-5-20260101',
  },
};

describe('loading', () => {
  it('routes an unconfigured workspace from the stated defaults', () => {
    const policy = loadTierPolicy(undefined);
    expect(policy.models.low).toBe('claude-haiku-4-5-20251001');
    expect(policy.max_tier).toBe('high');
  });

  it('rejects an unknown key rather than ignoring it', () => {
    // A typo'd knob that silently does nothing is the worst outcome available:
    // the user believes the capability is on.
    expect(() => TierPolicyConfigSchema.parse({ ...VALID, max_teir: 'low' })).toThrow();
  });

  it('refuses a model id that carries no version at all', () => {
    expect(carriesVersion('claude-opus')).toBe(false);
    expect(carriesVersion('gpt')).toBe(false);
    expect(() =>
      TierPolicyConfigSchema.parse({ models: { ...VALID.models, high: 'claude-opus' } }),
    ).toThrow(/carries no version/);
  });

  it('accepts a dateless generation id, which is its own pinned snapshot', () => {
    // The check used to demand a date stamp and REFUSED every current top-tier
    // model. Anthropic's docs: "every Claude model ID is a pinned snapshot,
    // including the dateless IDs used from the 4.6 generation on".
    expect(carriesVersion('claude-opus-5')).toBe(true);
    expect(carriesVersion('claude-sonnet-5')).toBe(true);
    // And a future minor still passes, which a shape rule keyed to "one trailing
    // integer means snapshot" would have got wrong.
    expect(carriesVersion('claude-opus-5-1')).toBe(true);
  });

  it('accepts a dated id, and does not claim to tell a snapshot from an alias', () => {
    // `claude-haiku-4-5` is a convenience alias that resolves to the dated id,
    // and `claude-opus-5` is a snapshot — identical in shape. No string test can
    // separate them, so this function does not pretend to; it rules out ids with
    // no version and stops there (P6-SURFACE-14).
    expect(carriesVersion('claude-haiku-4-5-20251001')).toBe(true);
    expect(carriesVersion('claude-haiku-4-5')).toBe(true);
  });

  it('defaults every tier to a model that is actually current', () => {
    // The defaults were a generation stale and had been since before the audit —
    // found on the built binary by P6-SURFACE-11, which printed the model it
    // routed to. A default nobody looks at is exactly the kind of thing that
    // rots quietly.
    const parsed = TierPolicyConfigSchema.parse({});
    expect(parsed.models.high).toBe('claude-opus-5');
    expect(parsed.models.medium).toBe('claude-sonnet-5');
    expect(parsed.models.low).toBe('claude-haiku-4-5-20251001');
    // Fable 5 is the highest-capability model and the most expensive. A default
    // nobody chose should not be the priciest option available.
    expect(Object.values(parsed.models)).not.toContain('claude-fable-5');
  });
});

describe('structural refusals', () => {
  it('refuses two tiers routed to the same model', () => {
    const problems = tierPolicyViolations(
      TierPolicyConfigSchema.parse({
        models: { ...VALID.models, high: VALID.models.medium },
      }),
    );
    expect(problems.join('\n')).toMatch(/both route to/);
  });

  it('refuses a fallback that crosses tiers', () => {
    // Falling back from high to the medium primary yields an answer that looks
    // like the work asked for and is not.
    const problems = tierPolicyViolations(
      TierPolicyConfigSchema.parse({
        ...VALID,
        fallbacks: { high: [VALID.models.medium] },
      }),
    );
    expect(problems.join('\n')).toMatch(/is the "medium" primary/);
  });

  it('refuses an override above the ceiling', () => {
    expect(() =>
      loadTierPolicy({ ...VALID, max_tier: 'medium', stage_overrides: { review: 'high' } }),
    ).toThrow(TierPolicyError);
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing a three-line mistake should not be a three-attempt process.
    try {
      loadTierPolicy({
        models: { ...VALID.models, high: VALID.models.medium },
        max_tier: 'low',
        skill_overrides: { review: 'high' },
      });
      expect.unreachable('expected a TierPolicyError');
    } catch (error) {
      expect((error as TierPolicyError).problems.length).toBeGreaterThan(1);
    }
  });

  it('ranks tiers so the ceiling means what it says', () => {
    expect(exceedsCeiling('high', 'medium')).toBe(true);
    expect(exceedsCeiling('medium', 'medium')).toBe(false);
    expect(exceedsCeiling('low', 'high')).toBe(false);
  });
});

describe('model posture (P1-SEC-01)', () => {
  it('names every routed model that has not been declared', () => {
    // The failure mode is not "we answered wrongly" — it is "nobody ever asked".
    const policy = loadTierPolicy({
      ...VALID,
      posture: {
        [VALID.models.medium]: { license: 'proprietary-api', egress: 'provider' },
      },
    });
    expect(undeclaredModels(policy)).toEqual([VALID.models.high, VALID.models.low].sort());
  });

  it('counts fallbacks as routed — they run too', () => {
    const policy = loadTierPolicy({ ...VALID, fallbacks: { medium: ['sonnet-alt-2026-01-01'] } });
    expect(undeclaredModels(policy)).toContain('sonnet-alt-2026-01-01');
  });

  it('records "unknown" rather than guessing whether inputs train the model', () => {
    // Guessing `false` because it seems likely would turn an open question into
    // a recorded fact, and the record is the only thing anyone reads later.
    const posture = ModelPostureSchema.parse({ license: 'apache-2.0', egress: 'none' });
    expect(posture.trains_on_inputs).toBe('unknown');
  });

  it('refuses an unknown posture key rather than silently dropping it', () => {
    expect(
      ModelPostureSchema.safeParse({ license: 'x', egress: 'none', retenton: '30' }).success,
    ).toBe(false);
  });

  it('does not refuse to route an undeclared model', () => {
    // A solo developer running weights on their own machine owes nobody a
    // data-processing statement; a tool that demanded one would just be lied to.
    expect(() => loadTierPolicy(VALID)).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  exceedsCeiling,
  ModelPostureSchema,
  undeclaredModels,
  isPinnedModelId,
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

  it('refuses a model id that pins no version', () => {
    expect(isPinnedModelId('claude-opus')).toBe(false);
    expect(isPinnedModelId('claude-opus-4-5-20260101')).toBe(true);
    expect(() =>
      TierPolicyConfigSchema.parse({ models: { ...VALID.models, high: 'claude-opus' } }),
    ).toThrow(/version-pinned/);
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

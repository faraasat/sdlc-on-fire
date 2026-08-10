import { describe, expect, it } from 'vitest';
import {
  explainPolicy,
  NoRouteError,
  resolveTier,
  routeForDispatch,
  UnroutableTierError,
  type TierPolicy,
} from './tier-router.js';
import { CANONICAL_SKILLS, SPEC_SKILL, IMPLEMENT_SKILL } from './skills/canonical.js';
import { REVIEW_SKILL } from './skills/review.js';

/**
 * Tier → model routing (P0-AGENT-04).
 *
 * The point of these tests is precedence. A policy is easy to write and hard to
 * predict, and the failure mode is silent: a skill quietly running at the wrong
 * tier costs money or quality with no error anywhere.
 */

const policy: TierPolicy = {
  models: { low: 'model-low', medium: 'model-medium', high: 'model-high' },
};

describe('resolving a tier', () => {
  it('uses the skill own declared tier by default', () => {
    const resolved = resolveTier(SPEC_SKILL, policy);
    expect(resolved.tier).toBe(SPEC_SKILL.tier);
    expect(resolved.source).toBe('skill-default');
    expect(resolved.model).toBe('model-medium');
  });

  it('lets a stage override raise every skill at that stage', () => {
    const resolved = resolveTier(REVIEW_SKILL, {
      ...policy,
      stageOverrides: { review: 'high' },
    });
    expect(resolved.tier).toBe('high');
    expect(resolved.source).toBe('stage-override');
    expect(resolved.model).toBe('model-high');
  });

  it('lets a skill override beat a stage override', () => {
    // "Run every review high, except this one" must be expressible. The reverse
    // precedence would make the narrower statement impossible to write.
    const resolved = resolveTier(REVIEW_SKILL, {
      ...policy,
      stageOverrides: { review: 'high' },
      skillOverrides: { review: 'low' },
    });
    expect(resolved.tier).toBe('low');
    expect(resolved.source).toBe('skill-override');
  });

  it('reports where the tier came from, so an override is never invisible', () => {
    expect(resolveTier(IMPLEMENT_SKILL, policy).source).toBe('skill-default');
    expect(
      resolveTier(IMPLEMENT_SKILL, { ...policy, skillOverrides: { implement: 'high' } }).source,
    ).toBe('skill-override');
  });

  it('never lets a skill name a model directly', () => {
    // A skill naming claude-x goes stale on the next provider release, and then
    // every skill file needs editing to move.
    for (const skill of Object.values(CANONICAL_SKILLS)) {
      expect(skill).not.toHaveProperty('model');
      expect(JSON.stringify(skill)).not.toMatch(/claude-|gpt-|gemini-/);
    }
  });
});

describe('a policy that cannot route', () => {
  it('throws rather than falling back to some default model', () => {
    // A silent fallback is how a high-tier review ends up running on a cheap
    // model with nobody the wiser.
    const broken = { models: { low: 'model-low', medium: '', high: 'model-high' } } as TierPolicy;
    expect(() => resolveTier(SPEC_SKILL, broken)).toThrow(UnroutableTierError);
  });

  it('names both the tier and the skill that needed it', () => {
    const broken = { models: { low: '', medium: '', high: '' } } as TierPolicy;
    expect(() => resolveTier(SPEC_SKILL, broken)).toThrow(/spec/);
  });
});

describe('explaining a policy before committing to it', () => {
  it('resolves every skill so an operator can see what the policy does', () => {
    const skills = Object.values(CANONICAL_SKILLS);
    const explained = explainPolicy(skills, { ...policy, stageOverrides: { review: 'high' } });

    expect(explained).toHaveLength(skills.length);
    const review = explained.find((entry) => entry.skill === 'review');
    expect(review?.tier).toBe('high');
    expect(review?.source).toBe('stage-override');

    // Everything else keeps its own tier.
    const spec = explained.find((entry) => entry.skill === 'spec');
    expect(spec?.source).toBe('skill-default');
  });
});

describe('dispatch-time routing with fallbacks (P1-AGENT-06)', () => {
  const withFallbacks: TierPolicy = {
    ...policy,
    fallbacks: { medium: ['model-medium-b', 'model-medium-c'], high: [] },
  };

  it('uses the primary when it is reachable', async () => {
    const route = await routeForDispatch(SPEC_SKILL, withFallbacks, () => true);
    expect(route.model).toBe('model-medium');
    expect(route.usedFallback).toBe(false);
  });

  it('falls back in declared order', async () => {
    const route = await routeForDispatch(
      SPEC_SKILL,
      withFallbacks,
      (model) => model === 'model-medium-b',
    );
    expect(route.model).toBe('model-medium-b');
    expect(route.usedFallback).toBe(true);
  });

  it('never crosses tiers to find something that works', async () => {
    // Falling back from a high-tier review to a cheap model produces an answer
    // that looks like a review and is not — worse than failing.
    await expect(routeForDispatch(REVIEW_SKILL, withFallbacks, () => false)).rejects.toThrow(
      NoRouteError,
    );
  });

  it('names every model it tried, so the failure is diagnosable', async () => {
    await expect(routeForDispatch(SPEC_SKILL, withFallbacks, () => false)).rejects.toThrow(
      /model-medium, model-medium-b, model-medium-c/,
    );
  });

  it('stays within the tier an override selected', async () => {
    const route = await routeForDispatch(
      SPEC_SKILL,
      { ...withFallbacks, skillOverrides: { spec: 'high' } },
      (model) => model === 'model-high',
    );
    expect(route.tier).toBe('high');
    expect(route.model).toBe('model-high');
  });
});

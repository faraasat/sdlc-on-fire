import type { CanonicalSkill, SkillTier } from '@sdlc-on-fire/core';

/**
 * Tier → model routing (P0-AGENT-04, ADR-0028).
 *
 * A skill declares the *capability tier* its work needs, never a model ID: a
 * skill naming `claude-sonnet-4` goes stale on the next provider release, and
 * then every skill file needs editing to move. The mapping from tier to a
 * concrete model lives in one policy object, so changing models is a config
 * edit rather than a sweep through the skill catalogue.
 *
 * The resolution is a **deterministic disposer** (ADR-0040): given a skill and a
 * policy, the model is computed by precedence, not chosen. Nothing here asks a
 * model which model to use.
 */

/** Where a resolved tier came from. Reported so an override is never invisible. */
export type TierSource = 'skill-override' | 'stage-override' | 'skill-default';

export interface TierResolution {
  readonly tier: SkillTier;
  readonly source: TierSource;
  readonly model: string;
}

export interface TierPolicy {
  /** Concrete model per tier. The only place a model ID appears. */
  readonly models: Readonly<Record<SkillTier, string>>;
  /** Force a tier for one named skill. Highest precedence — most specific wins. */
  readonly skillOverrides?: Readonly<Record<string, SkillTier>> | undefined;
  /** Force a tier for every skill at a stage, e.g. run all reviews high. */
  readonly stageOverrides?: Readonly<Record<string, SkillTier>> | undefined;
}

export class UnroutableTierError extends Error {
  override readonly name = 'UnroutableTierError';
  constructor(tier: SkillTier, skill: string) {
    super(
      `no model configured for tier "${tier}" (needed by skill "${skill}") — ` +
        'every tier must map to a model, or a skill silently gets whatever the default is.',
    );
  }
}

/**
 * Resolves which tier a skill runs at, most-specific-wins.
 *
 * Precedence is skill override → stage override → the skill's own declared
 * tier. A skill override beats a stage override because it is the narrower
 * statement: "run everything at review high, except this one skill" has to be
 * expressible, and the reverse ordering would make it impossible.
 */
export function resolveTier(skill: CanonicalSkill, policy: TierPolicy): TierResolution {
  const bySkill = policy.skillOverrides?.[skill.name];
  const byStage = policy.stageOverrides?.[skill.stage];

  const tier: SkillTier = bySkill ?? byStage ?? skill.tier;
  const source: TierSource =
    bySkill !== undefined
      ? 'skill-override'
      : byStage !== undefined
        ? 'stage-override'
        : 'skill-default';

  const model = policy.models[tier];
  if (model === undefined || model.length === 0) {
    throw new UnroutableTierError(tier, skill.name);
  }

  return { tier, source, model };
}

/**
 * Resolves every skill at once, for `agents doctor` and for showing an operator
 * what a policy actually does before they commit to it.
 *
 * A policy is easy to write and hard to predict — three overrides interacting
 * across a dozen skills is exactly the kind of thing people get wrong silently.
 */
export function explainPolicy(
  skills: readonly CanonicalSkill[],
  policy: TierPolicy,
): readonly (TierResolution & { readonly skill: string })[] {
  return skills.map((skill) => ({ skill: skill.name, ...resolveTier(skill, policy) }));
}

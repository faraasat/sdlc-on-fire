import { exceedsCeiling, type CanonicalSkill, type SkillTier } from '@sdlc-on-fire/core';
import type { TierPolicyConfig } from '@sdlc-on-fire/core';
import { outputJsonSchema } from './skills/output-schemas.js';

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
  /** Models to try, in order, if `model` cannot be reached. May be empty. */
  readonly fallbacks: readonly string[];
}

export interface TierPolicy {
  /** Concrete model per tier. The only place a model ID appears. */
  readonly models: Readonly<Record<SkillTier, string>>;
  /**
   * Ordered alternatives per tier, tried when the primary is unavailable
   * (P1-AGENT-06).
   *
   * Fallbacks are declared per tier rather than globally because "what to use
   * instead" depends on what the work needed. Falling back from a high-tier
   * review to a cheap model produces an answer that looks like a review and is
   * not, which is worse than failing — so a tier with no acceptable substitute
   * declares none and the dispatch fails loudly.
   */
  readonly fallbacks?: Readonly<Partial<Record<SkillTier, readonly string[]>>> | undefined;
  /** Force a tier for one named skill. Highest precedence — most specific wins. */
  readonly skillOverrides?: Readonly<Record<string, SkillTier>> | undefined;
  /** Force a tier for every skill at a stage, e.g. run all reviews high. */
  readonly stageOverrides?: Readonly<Record<string, SkillTier>> | undefined;
  /**
   * The highest tier any skill may resolve to (ADR-0029, P1-AGENT-08).
   *
   * Absent means no ceiling. Enforced at resolution rather than only at config
   * load, because a skill's *own* declared tier can exceed the ceiling without
   * any override being involved — a catalogue edit would otherwise walk straight
   * past a limit the workspace deliberately set.
   */
  readonly maxTier?: SkillTier | undefined;
}

export class TierCeilingError extends Error {
  override readonly name = 'TierCeilingError';
  constructor(skill: string, tier: SkillTier, ceiling: SkillTier, source: TierSource) {
    super(
      `skill "${skill}" resolves to tier "${tier}" (${source}) but this workspace caps subagents ` +
        `at "${ceiling}". Raise \`agents.max_tier\` deliberately, or lower the tier — silently ` +
        'running below the requested level would produce an answer that looks like the work asked for.',
    );
  }
}

/**
 * A skill routed to the cheap tier whose output nothing could check
 * (P1-GATE-05, ADR-0028 §4).
 *
 * The tier's justification is that its output is verifiable, so a skill with no
 * resolvable output schema has no business running there. Refusing at
 * *resolution* rather than after dispatch matters: by the time an unverifiable
 * cheap answer exists, the cheapest thing to do with it is believe it.
 */
export class UnverifiableLowTierError extends Error {
  override readonly name = 'UnverifiableLowTierError';
  constructor(skill: string, ref: string, source: TierSource) {
    super(
      `skill "${skill}" resolves to tier "low" (${source}) but its output contract ` +
        `"${ref}" resolves to no schema, so nothing could verify what it produced. ` +
        'Cheap-tier output is trusted only when it is actually checked (ADR-0028 §4) — ' +
        'give the skill a resolvable schema, or route it at medium.',
    );
  }
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

  // The ceiling refuses rather than downgrades. Quietly running a high-tier
  // review at medium yields something that reads exactly like a high-tier
  // review, which is the failure this whole tier system exists to prevent.
  if (policy.maxTier !== undefined && exceedsCeiling(tier, policy.maxTier)) {
    throw new TierCeilingError(skill.name, tier, policy.maxTier, source);
  }

  // The second half of ADR-0028 §4, which nothing enforced: cheap output is
  // trusted only when it can actually be verified. The router already decided
  // this runs cheap; this decides whether it is allowed to.
  if (tier === 'low' && outputJsonSchema(skill.output_contract.json_schema_ref) === undefined) {
    throw new UnverifiableLowTierError(skill.name, skill.output_contract.json_schema_ref, source);
  }

  const model = policy.models[tier];
  if (model === undefined || model.length === 0) {
    throw new UnroutableTierError(tier, skill.name);
  }

  return { tier, source, model, fallbacks: policy.fallbacks?.[tier] ?? [] };
}

export class NoRouteError extends Error {
  override readonly name = 'NoRouteError';
  constructor(skill: string, tier: SkillTier, tried: readonly string[]) {
    super(
      `every model for tier "${tier}" was unavailable for skill "${skill}" (tried ${tried.join(', ')}). ` +
        'Refusing rather than substituting a model from another tier — an answer produced at the ' +
        'wrong capability level looks like the right one.',
    );
  }
}

/**
 * Dispatch-time routing: the first model that is actually reachable
 * (P1-AGENT-06).
 *
 * `isAvailable` is injected rather than probed here, because "available" means
 * different things to different callers — a rate-limit window, a missing API
 * key, a provider outage. What this owns is the *order*, and the rule that we
 * never silently cross tiers to find something that works.
 */
export async function routeForDispatch(
  skill: CanonicalSkill,
  policy: TierPolicy,
  isAvailable: (model: string) => Promise<boolean> | boolean,
): Promise<{ model: string; tier: SkillTier; usedFallback: boolean }> {
  const resolved = resolveTier(skill, policy);
  const candidates = [resolved.model, ...resolved.fallbacks];

  for (const [index, model] of candidates.entries()) {
    if (await isAvailable(model)) {
      return { model, tier: resolved.tier, usedFallback: index > 0 };
    }
  }
  throw new NoRouteError(skill.name, resolved.tier, candidates);
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

/**
 * Turns the `agents:` config section into a routing policy.
 *
 * The conversion is deliberately dumb — a rename, nothing more. Any judgement
 * here would be a second place where policy is decided, and the point of
 * P1-AGENT-08 is that there is exactly one.
 */
export function tierPolicyFromConfig(config: TierPolicyConfig): TierPolicy {
  return {
    models: config.models,
    fallbacks: config.fallbacks,
    skillOverrides: config.skill_overrides,
    stageOverrides: config.stage_overrides,
    maxTier: config.max_tier,
  };
}

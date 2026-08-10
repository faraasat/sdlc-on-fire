import { z } from 'zod';
import { SKILL_TIERS, SkillTierSchema, type SkillTier } from './skill.js';

/**
 * The tier policy as *configuration* (P1-AGENT-08, ADR-0028/0029).
 *
 * `TierPolicy` shipped in P0-AGENT-04 as an interface and P1-AGENT-06 added
 * fallback routing — but nothing ever built one from a file. Every caller passed
 * a literal, so in a real workspace the policy was whatever the calling code
 * happened to hardcode, and the ADR-0028 rule that a model id appears in exactly
 * one place was true of the *type* and false of the system.
 *
 * This is that one place. The enforcement here is deliberately structural rather
 * than advisory: a policy that cannot route is refused at load, not discovered
 * at dispatch, because a policy error found mid-run has already spent tokens.
 */

/**
 * Whether a model id pins a version.
 *
 * A bare family name (`claude-opus`, `gpt-5`) is refused for the same reason
 * evidence refuses it (P1-GATE-09) and commit provenance refuses it (P1-GIT-01):
 * two contradictory results from "the same model" are indistinguishable without
 * a version, so an unpinned id makes every later comparison unanswerable. The
 * rule is shallow on purpose — a trailing date stamp or numeric version — since
 * a vendor-specific allowlist goes stale faster than the models do.
 */
export function isPinnedModelId(model: string): boolean {
  const trimmed = model.trim();
  return /\d/.test(trimmed) && /(?:-\d{6,8}|[-.@]v?\d+(?:[-.]\d+)+|-\d+-\d+)$/.test(trimmed);
}

const PinnedModelSchema = z
  .string()
  .min(1)
  .refine(isPinnedModelId, {
    message:
      'not a version-pinned model id. Two contradictory results from "the same model" ' +
      'cannot be told apart without a version — use e.g. `claude-opus-4-5-20260101`.',
  });

/**
 * `agents:` in `.sdlcof/config.yaml`.
 *
 * Unknown keys are rejected rather than ignored, matching the capability
 * registry: a typo'd knob that silently does nothing is the worst outcome
 * available, because the user believes it took effect.
 */
export const TierPolicyConfigSchema = z
  .object({
    /**
     * Concrete model per tier.
     *
     * Each carries its own default so a partial `agents: { models: { high: … } }`
     * still routes. Defaulting the whole object instead would mean overriding one
     * tier silently unconfigured the other two.
     */
    models: z
      .object({
        low: PinnedModelSchema.default('claude-haiku-4-5-20251001'),
        medium: PinnedModelSchema.default('claude-sonnet-4-5-20250929'),
        high: PinnedModelSchema.default('claude-opus-4-5-20260101'),
      })
      .prefault({}),
    /** Ordered alternatives per tier, tried when the primary is unreachable. */
    fallbacks: z
      .object({
        low: z.array(PinnedModelSchema).default([]),
        medium: z.array(PinnedModelSchema).default([]),
        high: z.array(PinnedModelSchema).default([]),
      })
      .prefault({}),
    /** Force a tier for one named skill. Most specific, so highest precedence. */
    skill_overrides: z.record(z.string(), SkillTierSchema).prefault({}),
    /** Force a tier for every skill at a stage, e.g. run all reviews high. */
    stage_overrides: z.record(z.string(), SkillTierSchema).prefault({}),
    /**
     * The highest tier a subagent may run at.
     *
     * ADR-0029's cost rule is that high tier is *rare* — but "rare" is a habit,
     * and habits do not survive a config edit made in a hurry. A ceiling turns
     * it into something a machine can refuse. It defaults to `high` (no
     * restriction) because silently capping a workspace that never asked for a
     * cap would be its own surprise.
     */
    max_tier: SkillTierSchema.default('high'),
  })
  .strict()
  // An unconfigured workspace still routes: the defaults live on the fields, so
  // "what runs by default" has one readable answer rather than being injected at
  // each call site.
  .prefault({});

export type TierPolicyConfig = z.infer<typeof TierPolicyConfigSchema>;

const TIER_RANK: Readonly<Record<SkillTier, number>> = { low: 0, medium: 1, high: 2 };

/** Whether `tier` exceeds the configured ceiling. */
export function exceedsCeiling(tier: SkillTier, ceiling: SkillTier): boolean {
  return TIER_RANK[tier] > TIER_RANK[ceiling];
}

/**
 * Structural problems in a loaded policy, as human-readable lines.
 *
 * Returned rather than thrown so a caller can report every problem at once. A
 * loader that threw on the first would make fixing a three-line mistake a
 * three-attempt process.
 */
export function tierPolicyViolations(config: TierPolicyConfig): readonly string[] {
  const problems: string[] = [];
  const primaries = new Map<string, SkillTier>();
  for (const tier of SKILL_TIERS) {
    primaries.set(config.models[tier], tier);
  }

  // The same model serving two tiers makes the tier distinction decorative: a
  // "high-tier review" routed to the medium model is a medium review wearing a
  // label, and every downstream decision that trusted the tier is now wrong.
  for (const tier of SKILL_TIERS) {
    const owner = primaries.get(config.models[tier]);
    if (owner !== undefined && owner !== tier) {
      problems.push(
        `tiers "${owner}" and "${tier}" both route to ${config.models[tier]} — ` +
          'a tier that is not a different model is a label, not a capability level',
      );
    }
  }

  for (const tier of SKILL_TIERS) {
    for (const fallback of config.fallbacks[tier]) {
      const owner = primaries.get(fallback);
      if (owner !== undefined && owner !== tier) {
        problems.push(
          `tier "${tier}" falls back to ${fallback}, which is the "${owner}" primary — ` +
            'a cross-tier fallback produces an answer that looks like the work asked for and is not',
        );
      }
    }
  }

  for (const [skill, tier] of Object.entries(config.skill_overrides)) {
    if (exceedsCeiling(tier, config.max_tier)) {
      problems.push(
        `skill override "${skill}: ${tier}" exceeds max_tier "${config.max_tier}" — ` +
          'raise the ceiling deliberately or lower the override',
      );
    }
  }
  for (const [stage, tier] of Object.entries(config.stage_overrides)) {
    if (exceedsCeiling(tier, config.max_tier)) {
      problems.push(
        `stage override "${stage}: ${tier}" exceeds max_tier "${config.max_tier}" — ` +
          'raise the ceiling deliberately or lower the override',
      );
    }
  }

  return problems;
}

export class TierPolicyError extends Error {
  override readonly name = 'TierPolicyError';
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`tier policy is unusable:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** Parses and validates `agents:`, refusing a policy that cannot route. */
export function loadTierPolicy(raw: unknown): TierPolicyConfig {
  const config = TierPolicyConfigSchema.parse(raw ?? {});
  const problems = tierPolicyViolations(config);
  if (problems.length > 0) throw new TierPolicyError(problems);
  return config;
}

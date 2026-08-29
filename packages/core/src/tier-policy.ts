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
 * Whether a model id carries a version at all.
 *
 * A bare family name (`claude-opus`, `gpt`) is refused for the same reason
 * evidence refuses it (P1-GATE-09) and commit provenance refuses it (P1-GIT-01):
 * two contradictory results from "the same model" are indistinguishable without
 * a version, so an id with none makes every later comparison unanswerable.
 *
 * **Renamed from `isPinnedModelId` on 2026-08-24 (P6-SURFACE-14), because it
 * never checked that.** It checked a *shape* — a trailing date stamp or dotted
 * version — and inferred "pinned" from it. That inference used to hold and no
 * longer does, in both directions:
 *
 * - It **rejected every current top-tier model.** Anthropic's docs state that
 *   "every Claude model ID is a pinned snapshot, including the dateless IDs used
 *   from the 4.6 generation on", and that "dateless IDs are their own pinned
 *   snapshot". So `claude-opus-5` is pinned, and the old rule refused it.
 * - It **accepted `claude-haiku-4-5`**, which for pre-4.6 models is a
 *   convenience *alias* that resolves to the dated id — exactly the unpinned
 *   thing the rule existed to catch.
 *
 * No shape can tell those apart: `claude-opus-5` is a snapshot and
 * `claude-haiku-4-5` is an alias, and a future `claude-opus-5-1` would be a
 * snapshot again. "Is this a pinned snapshot" is now vendor knowledge, not
 * syntax — and the original comment's reasoning still stands, that a
 * vendor-specific allowlist goes stale faster than the models do.
 *
 * So the claim is narrowed to what a string can actually support: this rules out
 * an id with no version component, and does not pretend to certify pinning.
 * Source: platform.claude.com/docs/en/about-claude/models/overview, fetched
 * 2026-08-24 (tier A — the vendor's own documentation).
 */
export function carriesVersion(model: string): boolean {
  const trimmed = model.trim();
  // A version component: a date stamp, a dotted/dashed version, or a trailing
  // bare integer (the dateless-snapshot form). `gpt` fails; `gpt-5` passes.
  return /\d/.test(trimmed) && /(?:-\d{6,8}|[-.@]v?\d+(?:[-.]\d+)*|-\d+(?:-\d+)*)$/.test(trimmed);
}

/** @deprecated Renamed to {@link carriesVersion}, which is what it checks. */
export const isPinnedModelId = carriesVersion;

/**
 * Where prompts go. The most consequential answer on the checklist, because it
 * decides whether the rest of it is about your disk or somebody else's.
 */
export const EGRESS_KINDS = ['none', 'provider', 'third-party'] as const;
export const EgressSchema = z.enum(EGRESS_KINDS);

/**
 * One model's declared terms (P1-SEC-01, `model-posture-checklist.md`).
 *
 * `unknown` is a first-class answer for `trains_on_inputs`. Guessing `false`
 * because it seems likely would turn an open question into a recorded fact, and
 * the record is the only thing anyone will read later.
 */
export const ModelPostureSchema = z
  .object({
    /** Weight licence for a local model, or the service's commercial terms. */
    license: z.string().min(1),
    egress: EgressSchema,
    /** Where inference happens, when known. */
    region: z.string().optional(),
    /** Days prompts are retained, or `zero` where that mode is contracted *and* enabled. */
    retention: z.string().optional(),
    trains_on_inputs: z.union([z.boolean(), z.literal('unknown')]).default('unknown'),
    notes: z.string().optional(),
  })
  .strict();

const PinnedModelSchema = z
  .string()
  .min(1)
  .refine(isPinnedModelId, {
    message:
      'model id carries no version. Two contradictory results from "the same model" ' +
      'cannot be told apart without one — use e.g. `claude-opus-5` (dateless ids from the ' +
      '4.6 generation on are their own pinned snapshot) or `claude-haiku-4-5-20251001`.',
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
        // Current generation as of 2026-08-24 (P6-SURFACE-14), from the vendor's
        // model overview. `low` was already current; `medium` and `high` were a
        // generation stale and had been since before the audit.
        //
        // Fable 5 is deliberately not a default at any tier. It is the highest
        // available capability and priced accordingly ($10/$50 per MTok against
        // Opus 5's $5/$25), and a default nobody chose should not be the most
        // expensive option available.
        low: PinnedModelSchema.default('claude-haiku-4-5-20251001'),
        medium: PinnedModelSchema.default('claude-sonnet-5'),
        high: PinnedModelSchema.default('claude-opus-5'),
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
    /**
     * What the operator has established about each model's terms
     * (P1-SEC-01, `model-posture-checklist.md`).
     *
     * A **declaration**, never a verification — nobody can inspect a provider's
     * data handling from the outside. What this makes possible is that the
     * question gets asked where the routing decision is made, and that an
     * unanswered one is *visible* rather than absent. A model id appears in one
     * config file; the terms under which it may see your source code appear
     * nowhere at all unless something asks.
     *
     * Undeclared models still route. Blocking would be the wrong lever: a solo
     * developer running weights on their own machine owes nobody a
     * data-processing statement, and a tool that demanded one before it would
     * run would simply be lied to.
     */
    posture: z.record(z.string(), ModelPostureSchema).prefault({}),
  })
  .strict()
  // An unconfigured workspace still routes: the defaults live on the fields, so
  // "what runs by default" has one readable answer rather than being injected at
  // each call site.
  .prefault({});

export type TierPolicyConfig = z.infer<typeof TierPolicyConfigSchema>;
export type ModelPosture = z.infer<typeof ModelPostureSchema>;

/**
 * Models that are routed to but have no declared posture.
 *
 * Reported rather than refused. The failure mode here is not "we answered
 * wrongly", it is "nobody ever asked" — so the remedy is to keep asking, at the
 * place the decision is visible.
 */
export function undeclaredModels(config: TierPolicyConfig): readonly string[] {
  const routed = new Set<string>([
    ...Object.values(config.models),
    ...Object.values(config.fallbacks).flat(),
  ]);
  return [...routed].filter((model) => config.posture[model] === undefined).sort();
}

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

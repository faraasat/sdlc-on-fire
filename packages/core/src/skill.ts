import { z } from 'zod';

/**
 * The canonical skill IR, per contracts/04-skill-ir.md §2 and ADR-0007.
 *
 * One canonical source compiles to every agent surface (architecture §5's
 * "one canonical skill source" invariant). `skills/<name>/SKILL.md` is the only
 * thing anyone hand-edits; everything under `.claude/` or `AGENTS.md` is
 * compiler output.
 *
 * A field belongs here only if at least one adapter must *read* it to produce
 * correct output. A field that is only ever *set* per-target-per-project is
 * adapter config, not canonical IR — that line is what keeps one target's
 * specifics from leaking into the shared source (§2.2).
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lifecycle stages a skill can back. One skill authors one stage's behaviour. */
export const SKILL_STAGES = [
  'discovery',
  'spec',
  'decompose',
  'plan-story',
  'implement',
  'review',
  'retrospective',
] as const;
export const SkillStageSchema = z.enum(SKILL_STAGES);
export type SkillStage = z.infer<typeof SkillStageSchema>;

/**
 * Per-skill default capability tier (ADR-0028). Resolved to a concrete model by
 * the tier→model router at dispatch, never hardcoded to a model ID here — a
 * skill that names a model goes stale on every provider release.
 */
export const SKILL_TIERS = ['low', 'medium', 'high'] as const;
export const SkillTierSchema = z.enum(SKILL_TIERS);
export type SkillTier = z.infer<typeof SkillTierSchema>;

/** Whether the skill runs in the parent conversation or as an isolated subagent. */
export const CONTEXT_MODES = ['inline', 'fork'] as const;
export const ContextModeSchema = z.enum(CONTEXT_MODES);
export type ContextMode = z.infer<typeof ContextModeSchema>;

/**
 * Names the tool call the skill emits its result through, and points at a
 * Zod-derived JSON Schema — never prose describing a shape. A prose "return
 * something like this" is not a contract anything can check.
 */
export const OutputContractSchema = z.object({
  /** snake_case — this becomes a tool name in the agent's own namespace. */
  tool_name: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'tool_name must be snake_case'),
  json_schema_ref: z.string().min(1),
});

/**
 * The verify command the **daemon** runs and parses — never the agent
 * (architecture §5). This is the field `evaluateGate` consumes evidence against.
 */
export const SkillVerifySchema = z.object({
  command_template: z.string().min(1),
  done_criteria_ref: z.string().min(1),
});

export const SkillArgumentSchema = z.object({
  name: z.string().regex(KEBAB_CASE, 'argument names are kebab-case'),
  required: z.boolean(),
});

/** Tiered deprecation metadata (ADR-0034), read by `agents doctor`. */
export const SkillDeprecationSchema = z.object({
  deprecated_since: z.string().regex(SEMVER),
  removal_tier: z.enum(['warn', 'error', 'removed']),
  replacement_ref: z.string().min(1).optional(),
});

export const CanonicalSkillSchema = z
  .object({
    schema_version: z.string().regex(SEMVER, 'schema_version must be semver'),
    name: z.string().regex(KEBAB_CASE, 'skill names are kebab-case and stable once assigned'),
    description: z.string().min(1),
    stage: SkillStageSchema,
    tier: SkillTierSchema,
    /** Reference, never an inline copy — pack tuning and skill edits move on different cadences. */
    context_pack_spec_ref: z.string().min(1),
    role: z.string().min(1),
    /** Pointer to the MUST-level constitution slice for *this* stage only. */
    constitution_excerpt_ref: z.string().min(1),
    task: z.string().min(1),
    output_contract: OutputContractSchema,
    self_verification: z.string().min(1).optional(),
    stop_condition: z.string().min(1),
    verify: SkillVerifySchema,
    arguments: z.array(SkillArgumentSchema).optional(),
    paths: z.string().min(1).optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    disallowed_tools: z.array(z.string().min(1)).optional(),
    context_mode: ContextModeSchema.default('inline'),
    deprecation: SkillDeprecationSchema.optional(),
    hooks: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((skill, ctx) => {
    // A review skill that can pass silently is the failure mode adversarial
    // review exists to prevent (contract §2.2, borrowed from BMAD).
    if (skill.stage === 'review' && skill.self_verification === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['self_verification'],
        message: 'review-stage skills must declare self_verification (HALT-on-zero-findings)',
      });
    }

    // Granting and denying the same tool is a contradiction, and silently
    // resolving it either way would be a security-relevant guess.
    const allowed = new Set(skill.allowed_tools ?? []);
    const conflicts = (skill.disallowed_tools ?? []).filter((tool) => allowed.has(tool));
    if (conflicts.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['disallowed_tools'],
        message: `tools appear in both allowed_tools and disallowed_tools: ${conflicts.join(', ')}`,
      });
    }

    // Duplicate argument names make positional binding ambiguous.
    const names = (skill.arguments ?? []).map((argument) => argument.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['arguments'],
        message: 'argument names must be unique',
      });
    }

    // A required argument after an optional one can never be bound positionally.
    const firstOptional = (skill.arguments ?? []).findIndex((argument) => !argument.required);
    if (firstOptional !== -1) {
      const laterRequired = (skill.arguments ?? [])
        .slice(firstOptional + 1)
        .some((argument) => argument.required);
      if (laterRequired) {
        ctx.addIssue({
          code: 'custom',
          path: ['arguments'],
          message: 'required arguments must precede optional ones',
        });
      }
    }
  });

export type CanonicalSkill = z.infer<typeof CanonicalSkillSchema>;

/**
 * The fixed prompt-template section order (contract §2.3, ADR-0018).
 *
 * This order **is** the `stableUpToIndex` cache-boundary decision, not a
 * separate choice: stable sections first so a repeat invocation can reuse the
 * cached prefix.
 */
export const PROMPT_SECTION_ORDER = [
  'role',
  'constitution',
  'context-pack',
  'task',
  'examples',
  'output-contract',
  'self-verification',
  'stop-condition',
] as const;
export type PromptSection = (typeof PROMPT_SECTION_ORDER)[number];

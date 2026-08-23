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

/**
 * Lifecycle stages a skill can back. One skill authors one stage's behaviour.
 *
 * **Every value here must be a member of `LIFECYCLE_STAGES`, and a test enforces
 * it.** This list said `plan-story` until 2026-08-23 while the lifecycle called
 * the same stage `plan`. Nothing had ever noticed, because no skill claimed that
 * stage — and the moment one did (P6-PAYLOAD-01) the skill was written,
 * registered, compiled to all six targets and **unreachable**: `skillForStage`
 * is asked for `plan` and matches on `plan-story`.
 *
 * That is the fourth time this repository has found two copies of a vocabulary
 * that had never been in the same room, after the role registry, the MCP package
 * names and the comment-effect roles. Each time the copies agreed right up until
 * they did not, and each time the symptom was silence rather than an error. The
 * skill is still *named* `plan-story`; only the stage it claims is shared
 * vocabulary, and the name and the stage are different fields.
 *
 * `retrospective` is the one deliberate exception and is listed in
 * `SKILL_STAGES_OUTSIDE_LIFECYCLE` so the check can be total rather than
 * approximate.
 */
export const SKILL_STAGES = [
  'discovery',
  'spec',
  'decompose',
  'plan',
  'implement',
  'review',
  'retrospective',
] as const;

/**
 * Skill stages that are deliberately not lifecycle states.
 *
 * A retrospective happens after a card is done; it is not a state anything
 * transitions *into*. Named explicitly so the conformance test can assert the
 * whole of `SKILL_STAGES` rather than skipping what it cannot explain.
 */
export const SKILL_STAGES_OUTSIDE_LIFECYCLE = ['retrospective'] as const;
export const SkillStageSchema = z.enum(SKILL_STAGES);
export type SkillStage = z.infer<typeof SkillStageSchema>;

/**
 * Per-skill default capability tier (ADR-0028). Resolved to a concrete model by
 * the tier→model router at dispatch, never hardcoded to a model ID here — a
 * skill that names a model goes stale on every provider release.
 */
/**
 * Events that dispatch a skill without a stage change (contract 04 §2.1).
 *
 * A merge conflict is not a lifecycle state. It happens partway through
 * `implement` and arrives without the stage moving, so `resolve-conflict`
 * (P2-SKILL-07) had no expressible home: `stage: implement` collides with the
 * one-skill-per-stage rule, and inventing a `resolve-conflict` stage would put
 * a state in the machine that nothing ever transitions into.
 *
 * **Closed, like `SKILL_STAGES`.** An open string would let a skill declare a
 * trigger nothing dispatches — the same defect the stage validation exists to
 * prevent, arriving through a different field.
 */
/**
 * Events that dispatch a skill, as opposed to lifecycle stages (contract 04 §2.1).
 *
 * Closed on purpose: an open string lets a skill declare a trigger nothing
 * dispatches, which reads in review exactly like a skill that works.
 *
 * Each is named for the **trigger**, never for the skill it runs. A situation
 * called `architecture` would say only "this is when the architecture skill
 * runs" — circular, and silent about when it actually fires.
 */
export const SKILL_SITUATIONS = [
  'merge-conflict',
  /** A change touching more than one module. Most work items never do. */
  'crosses-module-boundary',
  /** A story large enough that the order of the work decides whether it lands. */
  'oversized-story',
] as const;
export const SkillSituationSchema = z.enum(SKILL_SITUATIONS);
export type SkillSituation = z.infer<typeof SkillSituationSchema>;

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
  /**
   * What the argument means, for targets that compile it into a schema.
   *
   * The first field this IR gained because a *target* needed it rather than
   * because the IR wanted it (contract 04 §2.2, P2-AGT-01). Claude Code's
   * `arguments` is a list of names and the model learns each one's meaning from
   * the surrounding prose; an MCP tool has no surrounding prose, so
   * `inputSchema` is the whole of what the model is told and a property with no
   * description is a blank it fills by guessing. Optional, because it changes
   * nothing for the targets that drop it.
   */
  description: z.string().min(1).optional(),
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
    /** Present on stage skills. Exactly one of `stage` / `situation` (contract 04 §2.1). */
    stage: SkillStageSchema.optional(),
    /** Present on situational skills — dispatched by an event, not by a stage. */
    situation: SkillSituationSchema.optional(),
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
    // Exactly one trigger. Neither means nothing dispatches the skill; both
    // means it claims two, and which one wins would be settled by whichever
    // code path read the file first rather than by anything written down.
    const triggers = [skill.stage, skill.situation].filter((value) => value !== undefined);
    if (triggers.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['stage'],
        message:
          triggers.length === 0
            ? 'a skill declares exactly one of `stage` or `situation` — with neither, nothing dispatches it (contract 04 §2.1)'
            : 'a skill declares exactly one of `stage` or `situation`, never both (contract 04 §2.1)',
      });
    }

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

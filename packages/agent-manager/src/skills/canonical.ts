import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';
import { REVIEW_SKILL } from './review.js';
import { RETROSPECTIVE_SKILL } from './retrospective.js';
import { RESOLVE_CONFLICT_SKILL } from './resolve-conflict.js';

/**
 * The canonical stage skills (P1-SKILL-01).
 *
 * v0.1 ships `spec` and `implement` (P1-SKILL-01), `review` (P1-SKILL-02) and
 * `retrospective` (P1-SKILL-03); discovery, decompose and plan-story remain
 * deferred. These are the source every agent surface compiles from (ADR-0007):
 * editing a compiled `.claude/skills/**` file is editing build output.
 *
 * `review` is registered here rather than only exported from its own module. A
 * skill absent from this registry is invisible to `skillForStage`, so the
 * `review` stage would report "no skill available" despite having one.
 *
 * They live as data here rather than as `skills/<name>/SKILL.md` files because
 * the workspace scaffolder that would emit those is `P0-CLI-03`, deferred past
 * v0.1. The shape is identical; only the storage location moves.
 */

export const SPEC_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'spec',
  description:
    'Turn a work item into a spec with mechanically checkable acceptance criteria, before any code is written.',
  stage: 'spec',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/spec.yaml',
  role: [
    'You are the Spec agent for a work item entering the spec stage.',
    'You write acceptance criteria; you do not write code, and you do not advance the lifecycle state yourself.',
    'If the work item is too vague to specify, say so and stop — inventing requirements is worse than reporting the gap.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#specification',
  task: [
    'Write the spec for {{work_item_id}}.',
    'Every acceptance criterion MUST be in GIVEN/WHEN/THEN form and MUST be checkable by a command,',
    'not by reading. State non-goals explicitly.',
  ].join(' '),
  output_contract: {
    tool_name: 'spec_output',
    json_schema_ref: 'schemas/spec-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm every acceptance criterion names an observable outcome,',
    'and that a reader could tell pass from fail without asking you.',
  ].join(' '),
  stop_condition:
    'Stop after one spec is emitted and validated. Do not begin implementation, and do not advance the stage.',
  verify: {
    command_template: '{{verify_command}}',
    done_criteria_ref: 'work-item#done',
  },
  arguments: [{ name: 'work-item-id', required: true }],
  context_mode: 'inline',
});

export const IMPLEMENT_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'implement',
  description:
    'Implement one scoped task against its linked spec and acceptance criteria, staying inside its declared file ownership.',
  stage: 'implement',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/implement.yaml',
  role: [
    'You are the Implementer agent for a task in the implement stage.',
    'You write code to satisfy the linked spec and acceptance criteria.',
    'You do not invent scope beyond the task, you do not edit files outside its declared file ownership,',
    'and you do not advance the lifecycle state yourself.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#engineering-principles',
  task: [
    'Implement {{work_item_id}}.',
    'Read the linked spec and any referenced decisions before writing code.',
    'Modify only files matching this task’s declared file ownership.',
  ].join(' '),
  output_contract: {
    tool_name: 'implement_output',
    json_schema_ref: 'schemas/implement-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm every acceptance criterion is addressed,',
    'and that you did not touch a file outside the declared ownership.',
    'Do not report that tests pass — the daemon runs verify and reads the output itself.',
  ].join(' '),
  stop_condition:
    'Stop after one implementation report is emitted. Do not run the gate, and do not advance the stage.',
  verify: {
    command_template: '{{verify_command}}',
    done_criteria_ref: 'work-item#done',
  },
  arguments: [{ name: 'work-item-id', required: true }],
  context_mode: 'inline',
});

/**
 * A skill that backs a lifecycle stage — `stage` guaranteed present.
 *
 * The guarantee is structural rather than a comment: `skillForStage` matches on
 * `stage`, so a situational skill can never be returned by it, and the type
 * says so instead of leaving every caller to re-derive it.
 */
export type StageSkill = CanonicalSkill & { stage: NonNullable<CanonicalSkill['stage']> };

/** Every canonical skill shipped in v0.1, by name. */
export const CANONICAL_SKILLS: Readonly<Record<string, CanonicalSkill>> = {
  spec: SPEC_SKILL,
  implement: IMPLEMENT_SKILL,
  review: REVIEW_SKILL,
  retrospective: RETROSPECTIVE_SKILL,
  'resolve-conflict': RESOLVE_CONFLICT_SKILL,
};

export function getSkill(name: string): CanonicalSkill | undefined {
  return CANONICAL_SKILLS[name];
}

/**
 * The skill that drives a lifecycle stage, or `undefined` when none does.
 *
 * Resolving by the skill's own `stage` field rather than a second lookup table
 * keeps one source of truth: a skill that changes stage cannot go on being
 * dispatched for the old one. Stages with no skill (`test`, `done`) return
 * `undefined` deliberately — the daemon runs verify, and `done` is a gate
 * outcome, so neither is an agent's job.
 */
export function skillForStage(stage: string): StageSkill | undefined {
  return Object.values(CANONICAL_SKILLS).find(
    (skill): skill is StageSkill => skill.stage !== undefined && skill.stage === stage,
  );
}

/**
 * The skill dispatched by an event rather than by a stage (contract 04 §2.1).
 *
 * Separate from {@link skillForStage} rather than one lookup over both, because
 * the two are reached from different places: the lifecycle asks "what drives
 * this stage", and the git manager asks "what handles a merge conflict". A
 * single function taking either would let a stage name find a situational
 * skill by accident.
 */
export function skillForSituation(situation: string): CanonicalSkill | undefined {
  return Object.values(CANONICAL_SKILLS).find((skill) => skill.situation === situation);
}

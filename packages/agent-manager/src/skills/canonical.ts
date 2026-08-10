import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The canonical stage skills (P1-SKILL-01).
 *
 * v0.1 ships **two** — `spec` and `implement` — per mvp-slice; discovery,
 * decompose, plan-story and retrospective are deferred. These are the source
 * every agent surface compiles from (ADR-0007): editing a compiled
 * `.claude/skills/**` file is editing build output.
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
    'Write the spec for {{work_item_id}}: {{work_item_title}}.',
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
    'Implement {{work_item_id}}: {{work_item_title}}.',
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

/** Every canonical skill shipped in v0.1, by name. */
export const CANONICAL_SKILLS: Readonly<Record<string, CanonicalSkill>> = {
  spec: SPEC_SKILL,
  implement: IMPLEMENT_SKILL,
};

export function getSkill(name: string): CanonicalSkill | undefined {
  return CANONICAL_SKILLS[name];
}

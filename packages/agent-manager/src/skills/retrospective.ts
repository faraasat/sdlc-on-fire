import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The retrospective / memory-on-ship skill (P1-SKILL-03).
 *
 * Runs once, when a work item ships, and emits **one** reusable memory entry.
 *
 * The design pressure here is entirely in the opposite direction from most
 * retrospectives: the failure mode is not too little captured, it is too much.
 * A memory store that accumulates every observation becomes a store nobody
 * reads, and a wrong remembered fact is worse than no memory at all
 * (ADR-0023) — it gets retrieved with the same confidence as a right one and
 * quietly steers later work.
 *
 * So the skill is written to *refuse* most of what it could say: no restating
 * what the diff already shows, no generic process advice, and an explicit
 * instruction to emit nothing rather than pad. "We should write more tests" is
 * the archetypal wasted memory — true everywhere, actionable nowhere.
 */
export const RETROSPECTIVE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'retrospective',
  description:
    'On ship, capture at most one durable, reusable lesson from a work item — or explicitly capture nothing.',
  stage: 'retrospective',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/retrospective.yaml',
  role: [
    'You are the Retrospective agent for a work item that has just shipped.',
    'You capture what a future contributor to THIS codebase would have wanted to know before starting,',
    'and nothing else. You do not review the work, you do not propose follow-up tasks,',
    'and you do not advance the lifecycle state.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#memory',
  task: [
    'Write at most one memory entry for {{work_item_id}}: {{work_item_title}}.',
    'It must be a durable fact about this codebase or its constraints — something that will still be',
    'true and still be useful in six months. Anything a reader could get from the diff, the spec,',
    'or general engineering advice is NOT a memory entry.',
    'If nothing meets that bar, emit an empty entry and say why. That is the expected outcome for',
    'most routine work, not a failure.',
  ].join(' '),
  output_contract: {
    tool_name: 'retrospective_output',
    json_schema_ref: 'schemas/retrospective-output.schema.json',
  },
  self_verification: [
    'Before emitting, test the entry against three questions.',
    'Would this still be true in six months? Could a reader have gotten it from the diff alone?',
    'Does it name something specific to this codebase rather than to software in general?',
    'If any answer disqualifies it, emit nothing. A store of plausible-sounding generalities is',
    'worse than an empty one, because it is retrieved with the same confidence as a fact.',
  ].join(' '),
  stop_condition:
    'Stop after one memory entry (or one explicit refusal) is emitted. Do not open follow-up work items.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true }],
  context_mode: 'fork',
});

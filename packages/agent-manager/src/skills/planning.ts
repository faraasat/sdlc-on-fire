/**
 * The planning half of the lifecycle (P6-PAYLOAD-01).
 *
 * `sdlc skills compile` emitted **five** skills against roughly thirty declared
 * in [07-features.md]. Phase 5 finished the *distribution* — six compile targets,
 * drift-checked against a live registry — and the distribution was carrying a
 * thin payload. These are FEAT-SKILL-002/004/005/008/009.
 *
 * Two rules shape every one of them, and both come from what the existing five
 * already got right:
 *
 * 1. **No skill advances the lifecycle.** Each says so in its own `role`. The
 *    daemon moves state when evidence says it may; a skill that advanced its own
 *    stage would be grading itself, which is the thing this product exists to
 *    refuse (ADR-0040).
 *
 * 2. **Every skill can stop without producing.** "This is too vague to plan,
 *    here is what is missing" is a legitimate output. A planning skill with no
 *    way to say that invents the plan instead, and an invented plan is worse
 *    than an absent one because it looks like work.
 */

import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';
import { WORK_ITEM_ID_ARG } from './arguments.js';

export const DISCOVERY_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'discovery',
  description:
    'Establish the problem, the people it affects and the constraints on solving it, before anybody proposes a solution.',
  stage: 'discovery',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/discovery.yaml',
  role: [
    'You are the Discovery agent for a work item entering the discovery stage.',
    'You establish what problem exists and for whom. You do not choose a solution, you do not write a spec, and you do not advance the lifecycle state yourself.',
    'Where the problem is genuinely unclear, report the gap — a discovery that invents a user need is worse than one that reports it could not find one.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#discovery',
  task: [
    'Establish the problem behind {{work_item_id}}.',
    'Name who is affected and how you know, the constraints that any solution must respect,',
    'and the open questions somebody must answer before a spec can be written.',
    'Separate what you were told from what you inferred.',
  ].join(' '),
  output_contract: {
    tool_name: 'discovery_output',
    json_schema_ref: 'schemas/discovery-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm every constraint names its source, and that no claim about a user',
    'is stated more confidently than the evidence behind it allows.',
  ].join(' '),
  stop_condition:
    'Stop after one discovery is emitted. Do not write a spec, propose an implementation, or advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

export const DECOMPOSE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'decompose',
  description:
    'Break a specified epic or feature into stories and tasks that can each be finished and verified on their own.',
  stage: 'decompose',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/decompose.yaml',
  role: [
    'You are the Decompose agent for a specified work item.',
    'You split work into independently verifiable pieces. You do not implement them, and you do not advance the lifecycle state yourself.',
    'If the parent spec has no checkable acceptance criteria, stop and say so — decomposing an unclear spec multiplies the ambiguity rather than resolving it.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#specification',
  task: [
    'Decompose {{work_item_id}} into stories or tasks.',
    'Every child MUST carry its own acceptance criteria and a `verify` command that decides it,',
    'and MUST be finishable without waiting on a sibling. Declare the file ownership each child expects,',
    'so two of them cannot be executed in parallel against the same files.',
  ].join(' '),
  output_contract: {
    tool_name: 'decompose_output',
    json_schema_ref: 'schemas/decompose-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm no two children declare the same file, that each one could be',
    'finished alone, and that every child traces to a criterion in the parent spec rather than to a new idea.',
  ].join(' '),
  stop_condition:
    'Stop after one decomposition is emitted. Do not begin any child, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

export const PLAN_STORY_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'plan-story',
  description:
    'Produce a self-contained execution capsule for one story: the context, the ordered steps and the check that decides it.',
  stage: 'plan',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/plan-story.yaml',
  role: [
    'You are the Planner agent for a single story entering the plan stage.',
    'You produce a capsule an implementer can execute without going back for more context. You do not write the code, and you do not advance the lifecycle state yourself.',
    'A capsule that needs a conversation to be usable has not been written.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#planning',
  task: [
    'Plan {{work_item_id}} as one self-contained capsule.',
    'Give the ordered steps, the files each step touches, the command that verifies the result,',
    'and every assumption the plan rests on. Name what is deliberately out of scope.',
  ].join(' '),
  output_contract: {
    tool_name: 'plan_story_output',
    json_schema_ref: 'schemas/plan-story-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm somebody with no memory of this conversation could execute the plan,',
    'and that the verify command would actually fail if the work were not done.',
  ].join(' '),
  stop_condition:
    'Stop after one plan is emitted. Do not start implementing it, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

/**
 * Architecture is situational, not a stage.
 *
 * It has no `stage`, deliberately. Most work items never need an architecture
 * pass, and binding one to a stage would put an architecture step in front of
 * every bug fix — the lifecycle fits the work, not the other way round
 * (FEAT-RUNTIME-002). `skillForStage` matches on `stage`, so a skill without one
 * can never be returned by it; the guarantee is structural rather than a comment.
 */
export const ARCHITECTURE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'architecture',
  situation: 'crosses-module-boundary',
  description:
    'Record the module boundaries, data flow and the decisions that constrain how a change may be built.',
  tier: 'high',
  context_pack_spec_ref: 'context-packs/architecture.yaml',
  role: [
    'You are the Architect agent, invoked when a change crosses module boundaries or sets a precedent.',
    'You decide structure and record why. You do not implement, and you do not advance the lifecycle state yourself.',
    'Prefer the boring option that fits what exists over the better one that does not — an architecture nobody can follow is a document, not an architecture.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#architecture',
  task: [
    'Record the architecture for {{work_item_id}}.',
    'Give the module boundaries, what crosses them, and the decisions a future change must respect.',
    'For each decision, state the alternative you rejected and what would make you revisit it.',
  ].join(' '),
  output_contract: {
    tool_name: 'architecture_output',
    json_schema_ref: 'schemas/architecture-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm every decision names a rejected alternative and a condition that would reverse it.',
    'A decision with no stated alternative was not a decision.',
  ].join(' '),
  stop_condition:
    'Stop after the architecture is emitted. Do not implement any of it, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

/** Also situational: sequencing advice, wanted only when a plan is large enough to need it. */
export const IMPLEMENTATION_PLANNING_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'implementation-planning',
  situation: 'oversized-story',
  description:
    'Turn an architecture and a story plan into an ordered implementation sequence with explicit checkpoints.',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/implementation-planning.yaml',
  role: [
    'You are the Implementation Planner, invoked when a story is large enough that the order of work matters.',
    'You decide sequence and checkpoints. You do not write the code, and you do not advance the lifecycle state yourself.',
    'Order for reversibility: put the steps that are hardest to undo last, behind a checkpoint that would catch the mistake.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#planning',
  task: [
    'Sequence the implementation of {{work_item_id}}.',
    'Give the ordered steps, what must be true before each one begins, and the checkpoint that proves it finished.',
    'Name the step after which a rollback stops being cheap.',
  ].join(' '),
  output_contract: {
    tool_name: 'implementation_planning_output',
    json_schema_ref: 'schemas/implementation-planning-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm every step has a checkpoint that could fail, and that the sequence',
    'does not require a later step to be finished before an earlier one can be checked.',
  ].join(' '),
  stop_condition:
    'Stop after the sequence is emitted. Do not begin step one, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

/**
 * `triage-bug` (P6-PAYLOAD-06) — the bug-shaped lifecycle's first stage.
 *
 * Found while building P6-PAYLOAD-04: `bug` and `dependency-upgrade` cards enter
 * the ladder at `triage`, and no skill claimed that stage. So a bug's first step
 * dispatched no agent where a feature's `discovery` dispatched one — not an
 * error, just a card sitting at a stage that answered "no skill drives this".
 *
 * **Named `triage-bug`, not `triage`.** `triage-capture` already exists for the
 * `sdlc triage` command, which promotes a capture into a work item — a different
 * act on a different object. One word on two dispatch paths is the mistake this
 * repository has now found five times, and the resolution is that dispatch
 * resolves by the `stage` field, so the *name* is free to be unambiguous.
 *
 * The pressure here is the opposite of `discovery`'s. Discovery is asked to find
 * everything; triage is asked to decide, quickly, whether this is real and how
 * bad it is — and its characteristic failure is investigating a bug thoroughly
 * enough to have fixed it. So the stop condition is explicit that reproduction
 * steps are the deliverable and a fix is not.
 */
export const TRIAGE_BUG_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'triage-bug',
  description:
    'Decide whether a reported bug is real, how bad it is, and what reproduces it — without fixing it.',
  stage: 'triage',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/triage-bug.yaml',
  role: [
    'You triage a reported defect. You establish whether it reproduces, what it affects, and how urgent it is.',
    'You do not fix it, you do not refactor around it, and you do not advance the stage.',
    'Deciding is the job; investigating until the fix is obvious is how triage becomes implementation.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#defects',
  task: [
    'Triage {{work_item_id}}.',
    'Establish reproduction first: the exact steps, the environment, and what actually happens versus what should.',
    'A defect nobody can reproduce is not yet a defect — say so plainly rather than filing a fix for a description.',
    'Then say what it affects and how badly, in terms of who hits it and how often.',
    '"Critical" applied to everything is the same as applying it to nothing.',
    'If the same defect is already on the board, say which item and stop.',
  ].join(' '),
  output_contract: {
    tool_name: 'triage_bug_output',
    json_schema_ref: 'schemas/triage-bug-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm the reproduction steps are ones somebody else could follow on a clean checkout.',
    'Steps that only work in the state your session happens to be in are the reason a bug reopens two weeks later marked "cannot reproduce".',
  ].join(' '),
  stop_condition:
    'Stop once the triage is emitted. Do not fix the defect, do not write a test for it, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The review stage skill (P1-SKILL-02).
 *
 * Carries the HALT-on-zero-findings clause the canonical schema *requires* of
 * review-stage skills. A reviewer that returns "looks good" on every diff is
 * indistinguishable from one that never ran, so the skill is told to treat an
 * empty finding list as a signal it did not look hard enough.
 */
export const REVIEW_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'review',
  description:
    'Review a completed change against its spec and acceptance criteria, and try to break it before it ships.',
  stage: 'review',
  tier: 'high',
  context_pack_spec_ref: 'context-packs/review.yaml',
  role: [
    'You are the Reviewer agent for a change awaiting review.',
    'Your job is to find what is wrong, not to confirm what is right.',
    'You do not fix what you find, and you do not advance the lifecycle state yourself.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#review',
  task: [
    'Review the change for {{work_item_id}}.',
    'Check it against every acceptance criterion, then look for what the criteria do not cover:',
    'unhandled failure paths, silent error swallowing, and claims in comments the code does not keep.',
  ].join(' '),
  output_contract: {
    tool_name: 'review_output',
    json_schema_ref: 'schemas/review-output.schema.json',
  },
  self_verification: [
    'HALT before emitting zero findings. An empty list means one of two things:',
    'the change is genuinely clean, or you did not look hard enough — and the second is far more common.',
    'If you have no findings, state explicitly what you checked and why each came back clean.',
    'Do not report that tests pass; the daemon runs verify and reads the output itself.',
  ].join(' '),
  stop_condition:
    'Stop after one review report is emitted. Do not fix the findings, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [{ name: 'work-item-id', required: true }],
  context_mode: 'fork',
});

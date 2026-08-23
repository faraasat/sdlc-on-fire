/**
 * The security review pass (P6-PAYLOAD-03, FEAT-SKILL-013).
 *
 * The machinery around it was already the densest area of the codebase —
 * `risk-surface`, `blast-radius`, `injection-scan`, `dangerous-command`,
 * `evaluate-gate`, `requireSecurityReview`. What was missing was the thing an
 * agent could actually be handed, and — found while building this — anything
 * that made the requirement *bite*.
 *
 * **This skill produces findings. It never approves.** `SECURITY_REVIEW_ROLES`
 * is `security` / `eng-lead`, a human, and the `approvals` trigger refuses an
 * agent at the database level (ADR-0010). An agent that reviewed the security
 * of a change and then cleared it would be the whole failure in one step, so
 * the output contract has no verdict field to fill in — the refusal is
 * structural rather than an instruction the model is asked to respect.
 */

import { CanonicalSkillSchema, RISK_SURFACES, type CanonicalSkill } from '@sdlc-on-fire/core';
import { WORK_ITEM_ID_ARG } from './arguments.js';

export const SECURITY_REVIEW_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'security-review',
  description:
    'Review a change that touches a high-risk surface and report what an attacker could do with it.',
  situation: 'high-risk-surface',
  tier: 'high',
  context_pack_spec_ref: 'context-packs/security-review.yaml',
  role: [
    'You are the Security Reviewer for a change that touched a high-risk surface.',
    'You report findings. You do not approve the change, you cannot approve it, and you do not advance the lifecycle state yourself —',
    'sign-off belongs to a human in the security or eng-lead role, and the database refuses an agent approval outright.',
    'Report what an attacker could do, not what a linter would say.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#security',
  task: [
    'Review {{work_item_id}} for security, given it touches {{surfaces}}.',
    `The surfaces this product tracks are ${RISK_SURFACES.join(', ')}.`,
    'For each finding, give the concrete path an attacker takes, what they gain, and the smallest change that closes it.',
    'Say plainly where you looked and where you did not — an unstated gap reads as a clean bill of health.',
  ].join(' '),
  output_contract: {
    tool_name: 'security_review_output',
    json_schema_ref: 'schemas/security-review-output.schema.json',
  },
  self_verification: [
    'Before emitting: for every finding, confirm you can state the attacker step by step.',
    'A finding you cannot turn into a sequence of actions is a code smell, and filing it as a vulnerability spends the reviewer credibility you will need for a real one.',
  ].join(' '),
  stop_condition:
    'Stop once the findings are emitted. Do not fix them, do not approve the change, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [
    { name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG },
    {
      name: 'surfaces',
      required: true,
      description: `The high-risk surfaces this change touched, from ${RISK_SURFACES.join(', ')}. Supplied by the risk scan rather than chosen by the reviewer, so a surface cannot be reviewed away by not mentioning it.`,
    },
  ],
  context_mode: 'fork',
});

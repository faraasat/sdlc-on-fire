/**
 * Writing tests for a tier (P6-PAYLOAD-02, FEAT-SKILL-011).
 *
 * **One skill, seven tiers — deliberately not the four the feature text asks
 * for.** FEAT-SKILL-011 predates [ADR-0044](docs/.plan/decisions/ADR-0044-comprehensive-tdd-test-taxonomy.md),
 * which grew the taxonomy to `unit`, `integration`, `smoke`, `regression`,
 * `property`, `concurrency` and `e2e`. Shipping four skills against a
 * seven-value vocabulary would leave three tiers with no way to be written and
 * would look finished — which is the exact shape the feature audit exists to
 * catch, reproduced by the work meant to close it. The tier is an argument, so
 * adding a tier to the taxonomy cannot leave a skill behind.
 *
 * **This skill writes tests; it never decides whether they passed.** The daemon
 * runs `verify` and reads the output itself, which is why the `test` lifecycle
 * stage dispatches no agent at all. A skill that both wrote the tests and
 * reported the result would be the self-report the product exists to refuse
 * (ADR-0040), so this one is situational and stops at "written".
 *
 * The tier is not decoration. `core/test-tiers.ts` decides tier membership from
 * the file path, and a gate that requires `integration` is not satisfied by a
 * unit test however good it is — so the skill is told where the file must land
 * rather than being left to guess and have the gate silently disagree.
 */

import { CanonicalSkillSchema, TEST_TIERS, type CanonicalSkill } from '@sdlc-on-fire/core';
import { WORK_ITEM_ID_ARG } from './arguments.js';

export const WRITE_TESTS_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'write-tests',
  description:
    'Write the tests for one tier of a work item, placed where the tier gate will actually find them.',
  situation: 'tier-unsatisfied',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/write-tests.yaml',
  role: [
    'You are the Test Author for one tier of a work item.',
    'You write tests and you do not advance the lifecycle state yourself.',
    'You do not report whether they pass — the daemon runs verify and reads the output itself.',
    'A test that cannot fail is not a test: if you cannot construct a case that would fail against the current code, say so instead of writing one that passes for the wrong reason.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#testing',
  task: [
    'Write the {{tier}} tests for {{work_item_id}}.',
    `Valid tiers are ${TEST_TIERS.join(', ')}.`,
    'Place each file where this tier is recognised — the tier is decided by path, and a gate requiring one tier is not satisfied by a test from another however good it is.',
    'For every test, state the failure it would catch. Cover the acceptance criteria first, then the edge cases the criteria imply.',
  ].join(' '),
  output_contract: {
    tool_name: 'write_tests_output',
    json_schema_ref: 'schemas/write-tests-output.schema.json',
  },
  self_verification: [
    'Before emitting: for each test, name the change to the production code that would make it fail.',
    'A test with no such change asserts something already guaranteed, and will pass forever without checking anything.',
  ].join(' '),
  stop_condition:
    'Stop once the tests for this one tier are written. Do not run them, do not report a result, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [
    { name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG },
    {
      name: 'tier',
      required: true,
      description: `Which test tier to write: one of ${TEST_TIERS.join(', ')}. Decides where the files must be placed, because tier membership is resolved from the path.`,
    },
  ],
  context_mode: 'inline',
});

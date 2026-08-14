import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The `resolve-conflict` skill (P2-SKILL-07, FEAT-SKILL-023).
 *
 * The first **situational** skill: dispatched by a merge conflict rather than
 * by a lifecycle stage (contract 04 §2.1). A conflict is not a state the
 * lifecycle moves into — it happens partway through `implement` and arrives
 * without the stage changing at all.
 *
 * Everything this skill is allowed to do is bounded by P2-GIT-02's checker,
 * and the division is the design rather than an implementation detail:
 *
 * - **The skill's deliverable is the rationale, not the resolution.** It edits
 *   the files, but what it *emits* is a per-hunk account of what each side was
 *   for and why the resolution is right — which is precisely what
 *   `sdlc conflicts --check --why` consumes. A skill whose output were "I
 *   resolved it" would be a self-report; a skill whose output is a declaration
 *   feeds a checker that can refuse it.
 * - **It never reports that tests pass.** The daemon runs verify and reads the
 *   output. `.research/27 §2.5` is explicit that the re-run is what makes an
 *   agent-assisted resolution trustworthy, and a skill permitted to assert the
 *   re-run's outcome would be permitted to skip it.
 *
 * `tier: medium` per the task spec, and it is the right tier: reading two
 * versions of a hunk and saying what each was for is squarely Sonnet-class
 * work, while the thing that would justify `high` — deciding the resolution is
 * *correct* — is not this skill's decision to make.
 */
export const RESOLVE_CONFLICT_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'resolve-conflict',
  description:
    'Explain both sides of a merge conflict and resolve it, declaring per hunk what was discarded and why.',
  situation: 'merge-conflict',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/resolve-conflict.yaml',
  role: [
    'You are the conflict-resolution agent for a branch whose merge stopped on a real conflict.',
    'Your job is to work out what each side was trying to do and why, and to resolve the file in a way that keeps both intentions where they can both be kept.',
    'You do not decide whether the resolution is correct — the re-run of the real checks decides that, and you do not run it — and you do not advance the lifecycle state yourself.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#implement',
  task: [
    'Resolve the conflicts in {{conflicted_paths}} for {{work_item_id}}.',
    'For each hunk, first state what our side changed and what their side changed relative to the common ancestor — not what each side now says, but what each side did.',
    'Then resolve it, and record which side you discarded, if any, and why.',
    'A hunk where both intentions survive needs no justification; a hunk where one does not, does.',
  ].join(' '),
  output_contract: {
    tool_name: 'resolve_conflict_output',
    json_schema_ref: 'schemas/resolve-conflict-output.schema.json',
  },
  self_verification: [
    'Before emitting, check three things about the file you have written.',
    'One: no conflict markers remain — a file still carrying them will compile in exactly the languages where that is worst.',
    'Two: for every hunk where you kept one side and dropped the other, you have written down what the dropped side was for.',
    'Taking a side is often right; taking one silently is indistinguishable from having missed it, and nothing downstream can tell those apart.',
    'Three: any code you wrote that came from neither side is called out as such — code written at a merge boundary is the least-reviewed code in the repository.',
    'Do not report that tests pass. You have not run them, and the daemon that does will read the output itself.',
  ].join(' '),
  stop_condition: [
    'Stop after the conflicted files are resolved and one declaration is emitted.',
    'Do not stage or commit, do not continue the merge, and do not advance the lifecycle stage —',
    'the resolution is unverified until the real checks have run against the resolved tree.',
  ].join(' '),
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [
    { name: 'work-item-id', required: true },
    { name: 'conflicted-paths', required: false },
  ],
  context_mode: 'fork',
});

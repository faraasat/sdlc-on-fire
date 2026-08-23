/**
 * The research skills (P6-PAYLOAD-05; FEAT-SKILL-006/007).
 *
 * Two skills, not eight. `research` covers all seven subtypes with the subtype
 * as an argument — the reasoning is in `core/research-subtype.ts` and it is the
 * same one P6-PAYLOAD-02 applied to the test tiers. `ui-explore` is separate
 * because it is a *different kind of thing*: not a research request somebody
 * made, but a pass that fires on its own when a change touches the interface.
 *
 * **The overlap between `research --subtype ui-ux` and `ui-explore` is real and
 * deliberate.** FEAT-SKILL-006 and FEAT-SKILL-007 were written separately and
 * they do overlap in content. What separates them is dispatch and direction:
 * `research ui-ux` is asked for, and looks outward at what the platform and the
 * standards require; `ui-explore` is triggered, and looks inward at what this
 * codebase already does. Collapsing them would have meant either losing the
 * automatic pass or making every research request fire automatically.
 */

import {
  CanonicalSkillSchema,
  RESEARCH_FOCUS,
  RESEARCH_SUBTYPES,
  type CanonicalSkill,
  type ResearchSubtype,
} from '@sdlc-on-fire/core';

/** The focus table, as the prompt sees it. Seven lines, one per subtype. */
const FOCUS_LINES = RESEARCH_SUBTYPES.map(
  (subtype: ResearchSubtype) => `- ${subtype}: ${RESEARCH_FOCUS[subtype]}`,
).join('\n');

/**
 * `research` (FEAT-SKILL-006).
 *
 * The prompt is mostly about **what not to do**, because the failure mode of a
 * research agent is not laziness. It is fluency: a confident, well-organised
 * answer assembled from recall and from whichever page ranked first, indistinguishable
 * in shape from one built out of primary sources. ADR-0073 exists because that
 * happened in this project's own corpus.
 *
 * So three rules, and the output contract enforces all three rather than asking
 * for them. Every finding carries its sources. `unverified` is a first-class
 * confidence, not a failure. And the tiering is done by
 * `assessSources` at the dispatch boundary, so "this is well sourced" is
 * computed rather than claimed (ADR-0040).
 */
export const RESEARCH_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'research',
  description:
    'Research one focused question — codebase, package, api, architecture, ui-ux, security or db — and report findings with their sources.',
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/research.yaml',
  role: [
    'You research one narrow question and report what you actually found.',
    'You do not design, you do not implement, you do not open work items, and you do not advance any stage.',
    'You are not being asked to be confident. You are being asked to be checkable:',
    'the reader must be able to follow every claim back to the thing you read.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#research',
  task: [
    'Research: {{question}} — as {{subtype}} research.',
    'Where each subtype looks first:',
    FOCUS_LINES,
    'Consult sources this session. Recall tells you what to look for; it is not a citation, and a claim',
    'you did not check this session is unverified however sure you are.',
    'Prefer the primary record — the paper with a method, the vendor’s own docs, the standard, the source',
    'itself — over anything written about it. A page reporting a number without a method is a lead, never a figure,',
    'and it is worth saying when the publisher sells the conclusion.',
    'Mark every finding verified or unverified. "Unverified" is a real answer and it is the one that keeps',
    'the rest of the report worth reading.',
  ].join('\n'),
  output_contract: {
    tool_name: 'research_output',
    json_schema_ref: 'schemas/research-output.schema.json',
  },
  self_verification: [
    'Before emitting: open every URL you are about to cite and confirm it says what you are citing it for.',
    'A citation that does not resolve, or resolves to something else, is worse than no citation —',
    'it is the form of evidence without the substance, and it is read as the substance.',
  ].join(' '),
  stop_condition:
    'Stop once the findings are emitted. Do not act on them, do not write code, and do not advance the stage.',
  verify: { command_template: 'sdlc research check', done_criteria_ref: 'research#sourced' },
  arguments: [
    {
      name: 'question',
      required: true,
      description:
        'The one question to answer. Narrow — a wave of seven narrow questions beats one agent covering seven concerns badly.',
    },
    {
      name: 'subtype',
      required: true,
      description: `Which kind of research this is: ${RESEARCH_SUBTYPES.join(', ')}. Decides where to look first, not how hard to look.`,
    },
  ],
  context_mode: 'fork',
});

/**
 * `ui-explore` (FEAT-SKILL-007).
 *
 * Situational, and the situation is real: `situationsFromDiff` computes
 * `touches-ui` from the changed paths, so this is dispatched by something rather
 * than declared to be. Getting that wrong was the specific risk — a
 * `touches-ui` value in a closed enum that no code produces reads exactly like a
 * dispatch path that works.
 *
 * The point is **before**: it runs ahead of UI work being planned, and its whole
 * value is that the answer arrives while changing it is still cheap. What it
 * reports is what already exists — components, tokens, spacing, the
 * accessibility conventions in use — so the next change is the second instance
 * of a pattern rather than the third way of doing one thing.
 */
export const UI_EXPLORE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'ui-explore',
  description:
    'Report the interface conventions this codebase already has, before UI-touching work is planned.',
  situation: 'touches-ui',
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/ui-explore.yaml',
  role: [
    'You explore the interface this codebase already has, so that work touching it does not start blind.',
    'You report conventions, not preferences: what is here and how consistently, not what you would have chosen.',
    'You do not redesign anything, you do not change any file, and you do not advance the stage.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#ui',
  task: [
    'Explore the interface conventions relevant to {{work_item_id}}, given it touches {{ui_paths}}.',
    'Find the components that already do something close to what this change needs, and say where they are.',
    'Report the design tokens, spacing and typography in use — where they are defined, and where they are bypassed.',
    'Report the accessibility conventions actually followed here, and where they are followed inconsistently:',
    'a pattern honoured in four places and skipped in the fifth is the one that breaks next.',
    'Say plainly when there is no convention. An invented one, reported as existing, is how a third way of',
    'doing one thing gets built by someone who thought they were following the second.',
  ].join(' '),
  output_contract: {
    tool_name: 'ui_explore_output',
    json_schema_ref: 'schemas/ui-explore-output.schema.json',
  },
  self_verification: [
    'Before emitting: every convention you report must name the files you read it off, more than one where you claim it is a convention.',
    'One example is an instance. Two are a coincidence. A convention is what the codebase does when nobody is looking at it.',
  ].join(' '),
  stop_condition:
    'Stop once the conventions are reported. Do not change any file, do not propose a redesign, and do not advance the stage.',
  verify: { command_template: '{{verify_command}}', done_criteria_ref: 'work-item#done' },
  arguments: [
    {
      name: 'work-item-id',
      required: true,
      description:
        'The id of the work item this run is about, e.g. FEAT-014. Must name an existing card.',
    },
    {
      name: 'ui-paths',
      required: true,
      description:
        'The interface files this change touches. Supplied by the diff scan rather than chosen, so a file cannot leave the scope by not being mentioned.',
    },
  ],
  context_mode: 'fork',
});

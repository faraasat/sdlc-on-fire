/**
 * The delivery skills (P6-PAYLOAD-04; FEAT-SKILL-001/014/015/018/019).
 *
 * Five capabilities that existed only as CLI commands — or, for
 * `release-notes`, as neither. The audit ([audit/02-skill.md]) called four of
 * them `partial` for the same reason each time: the command was built, tested
 * and reachable from a terminal, and there was nothing an agent working in a
 * chat window could be handed. The product's own claim is that you do not live
 * in the CLI, so a capability reachable only from it is half-shipped.
 *
 * **All five are `user_invoked`, and that is a new dispatch kind** (contract 04
 * §2.1). Filing them as situations was the obvious alternative and it is wrong:
 * a situation is a condition something *detects*, and no detector will ever
 * compute "the user wants to start a project". Four of the five are not even
 * card-scoped — `new-project` and `import` run before a work item exists,
 * `release-notes` spans many finished ones — so a trigger keyed to a card's
 * state cannot express them at all.
 *
 * **A naming collision, avoided rather than inherited.** `triage` means two
 * different things in this product: `sdlc triage` promotes a capture into a work
 * item, and `triage` is *also* a lifecycle stage — the bug-shaped alias for the
 * `discovery` slot, which `bug` and `dependency-upgrade` cards enter at. This
 * skill is the first one, so it is named `triage-capture`. Calling it `triage`
 * would have put one word on two dispatch paths, which is the fifth chance this
 * repository has had to make that exact mistake.
 *
 * (Found while checking that: the lifecycle stage `triage` has **no** skill, so
 * a bug's first stage dispatches no agent where a feature's `discovery` does.
 * That is a real gap and it is not this task's — recorded in the tracker.)
 */

import { CanonicalSkillSchema, type CanonicalSkill } from '@sdlc-on-fire/core';
import { WORK_ITEM_ID_ARG } from './arguments.js';

/**
 * `new-project` (FEAT-SKILL-001) — an idea becomes a workspace.
 *
 * `sdlc init` already scaffolds: directories, database, config. What it cannot
 * do is decide the rigor preset, write the project-specific MUSTs into the
 * constitution, and name the first few work items — which is the part that
 * needs judgement and is therefore the part worth a skill.
 *
 * The failure mode is not doing too little. It is a model handed three sentences
 * about an idea and returning a twelve-item backlog, a tech stack and a
 * six-month roadmap, none of which anybody said. Invented scope at the start of
 * a project is the most expensive kind: everything downstream inherits it, and
 * by the time it is questioned it looks like a decision someone made. So the
 * skill is told to put anything it is not sure about into `open_questions`
 * rather than into the plan, and `open_questions` may be the longer list.
 */
export const NEW_PROJECT_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'new-project',
  description:
    'Turn a project idea into an initialised workspace: a rigor preset, a project constitution, and the first work items.',
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/new-project.yaml',
  role: [
    'You are setting up a new SDLC on Fire workspace from a description of what someone wants to build.',
    'You decide how much process this project needs and write down what is actually known.',
    'You do not design the system, you do not choose the stack unless it was stated, and you do not',
    'produce a roadmap. Anything you are inferring rather than reading goes in open questions,',
    'and you do not advance any stage of the work you name.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#project-setup',
  task: [
    'Set up a workspace for: {{idea}}.',
    'Run `sdlc init` if the workspace does not exist yet.',
    'Pick one rigor preset — lite, standard or strict — and say what about this project decided it.',
    'A prototype nobody depends on and a payments service do not get the same gates.',
    'Write the constitution MUSTs that are specific to THIS project. Rules true of all software belong',
    'in no constitution: they are not read, and their presence teaches the reader to skim the ones that matter.',
    'Then name the first work items — the ones you could start tomorrow, not the ones that come after them.',
  ].join(' '),
  output_contract: {
    tool_name: 'new_project_output',
    json_schema_ref: 'schemas/new-project-output.schema.json',
  },
  self_verification: [
    'Before emitting: for every work item and every constitution rule, point at the sentence in the',
    'description that put it there. If you cannot, it is an open question, not a plan.',
    'A backlog longer than what you were told is a backlog you wrote.',
  ].join(' '),
  stop_condition:
    'Stop once the workspace is initialised and the first work items are emitted. Do not start implementing any of them, and do not advance any stage.',
  verify: { command_template: 'sdlc status --json', done_criteria_ref: 'workspace#initialized' },
  arguments: [
    {
      name: 'idea',
      required: true,
      description:
        'What the project is, in whatever detail the person has. Short is fine and common; the skill asks questions rather than filling gaps.',
    },
  ],
  context_mode: 'inline',
});

/**
 * `capture` (FEAT-SKILL-018) — soft insertion, mid-task, costing nothing.
 *
 * `sdlc capture` exists precisely so that noticing something does not require
 * choosing a kind, a parent, a preset and a stage. The skill has to preserve
 * that: a capture skill that stops to classify has rebuilt the ceremony the
 * command was written to avoid, and the observation goes in a text file
 * instead — or is lost.
 *
 * Two rules follow, and both are about restraint. **The note keeps the
 * observer's own words.** A paraphrase is a small, invisible loss: it survives
 * as the record of what was meant, and the sentence that actually explained it
 * is gone. **And nothing else moves** — no claim, no stage, no gate. The `low`
 * tier is the same decision in another form; a capture that needs a large model
 * is a capture that is doing too much.
 */
export const CAPTURE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'capture',
  description:
    'Record an observation as a capture without interrupting the work in flight — no kind, no parent, no triage.',
  user_invoked: true,
  tier: 'low',
  context_pack_spec_ref: 'context-packs/capture.yaml',
  role: [
    'You record something worth remembering and then get out of the way.',
    'You do not decide what it is, what it blocks, who owns it or how big it is.',
    'You do not touch the work in flight: no claim changes, no gate is consulted, and you do not advance a stage.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#insertion',
  task: [
    'Capture: {{note}}.',
    'Run `sdlc capture` with the observation. Keep the original wording — you are recording what was',
    'noticed, and the exact sentence is often the only record of what was actually meant.',
    'If several distinct things were noticed, capture each one separately; one capture holding three',
    'observations gets triaged as one and two of them disappear.',
    'Classifying it is a separate, later, deliberate act and it is not yours.',
  ].join(' '),
  output_contract: {
    tool_name: 'capture_output',
    json_schema_ref: 'schemas/capture-output.schema.json',
  },
  stop_condition:
    'Stop as soon as the capture ids are emitted and return to what you were doing. Do not triage, do not estimate, and do not open a work item.',
  verify: { command_template: 'sdlc status --json', done_criteria_ref: 'capture#recorded' },
  arguments: [
    {
      name: 'note',
      required: true,
      description:
        'The observation, in the words it was noticed in. Not a summary — the wording is the point.',
    },
  ],
  context_mode: 'inline',
});

/**
 * `triage-capture` (FEAT-SKILL-018) — a capture becomes a work item, or does not.
 *
 * The deliberate counterweight to `capture`. Capturing is cheap and frequent;
 * deciding what something *is* costs thought, happens later, and is often done
 * by someone else. `sdlc triage` is a separate command for that reason and this
 * is a separate skill for the same one.
 *
 * The output has a `verdict` — and unlike a gate verdict, this one is properly
 * the agent's: nothing is being approved, a capture is being classified, and
 * `drop` is a first-class outcome. An inbox where everything becomes a work item
 * is an inbox that has moved the backlog rather than triaged it.
 */
export const TRIAGE_CAPTURE_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'triage-capture',
  description:
    'Decide what a captured note actually is — promote it to a work item of a specific kind, merge it into an existing one, or drop it.',
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/triage-capture.yaml',
  role: [
    'You triage captures from the inbox. For each one you decide what it is: a bug, a feature, a task,',
    'a chore, a duplicate of work that already exists, or nothing worth keeping.',
    'You do not implement anything, you do not plan the work you promote, and you do not advance its stage.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#insertion',
  task: [
    'Triage {{capture_id}}.',
    'Read the note as written before deciding — the original wording usually says more than the summary.',
    'Search the existing work items first: a capture that restates open work should be merged into it,',
    'and a duplicate promoted into its own card splits the discussion in two.',
    'Promote it with `sdlc triage` once you have a kind, and say what the kind rests on.',
    'Dropping is a legitimate outcome and needs the same one-line reason as promoting.',
  ].join(' '),
  output_contract: {
    tool_name: 'triage_capture_output',
    json_schema_ref: 'schemas/triage-capture-output.schema.json',
  },
  self_verification: [
    'Before emitting: if you chose promote, confirm you searched for an existing item first and can name what you searched.',
    'A duplicate filed as new work is worse than an untriaged capture, because it looks like it was handled.',
  ].join(' '),
  stop_condition:
    'Stop once the verdict is emitted. Do not specify, plan or implement whatever you promoted, and do not advance its stage.',
  verify: { command_template: 'sdlc status --json', done_criteria_ref: 'capture#triaged' },
  arguments: [
    {
      name: 'capture-id',
      required: true,
      description:
        'The capture to triage, e.g. CAP-001. Must name an existing capture in the inbox.',
    },
  ],
  context_mode: 'inline',
});

/**
 * `import` (FEAT-SKILL-019) — an existing tool's specs and plans come in.
 *
 * The importer framework is built, round-trip-gated and reachable as
 * `sdlc import`. The judgement it cannot make is what the import *lost*.
 * Every source tool has concepts this one does not, and a mapping that silently
 * drops them produces a workspace that looks complete and quietly is not — the
 * user finds out weeks later, when the thing they are looking for was never
 * imported and nobody said so.
 *
 * So `unmapped` is required in the output. Two more rules: **dry run first,
 * always** — an import writes across a workspace and reading the plan costs one
 * command — and **conflicts are never overwritten without a human**, because
 * the file being overwritten is the one somebody already wrote.
 */
export const IMPORT_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'import',
  description:
    "Bring an existing tool's specs and plans into this workspace, and report what did not map.",
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/import.yaml',
  role: [
    'You import work from another tool into this workspace.',
    'You report what came in, what conflicted and what has no home here.',
    'You do not resolve conflicts by overwriting, and you do not improve the content on the way through —',
    'an imported spec that you rewrote is no longer the spec anybody agreed to. You do not advance the stage of anything you import.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#import',
  task: [
    'Import from {{source}} into this workspace.',
    'Run `sdlc import --dry-run` first and read the plan. It writes nothing and it is the only cheap',
    'moment to notice that the detection picked the wrong tool.',
    'Then run the real import. Leave `--on-conflict` at its default: a conflict means a file already',
    'exists that someone wrote, and choosing for them is not yours to do.',
    'Finally, list what did NOT map — the source concepts with no equivalent here. An import that',
    'reports only its successes reads as complete, and the gap surfaces weeks later as a missing document.',
  ].join(' '),
  output_contract: {
    tool_name: 'import_output',
    json_schema_ref: 'schemas/import-output.schema.json',
  },
  self_verification: [
    'Before emitting: confirm the dry run and the real run agree on what was written.',
    'A difference between them is not a detail to reconcile later — it means the plan you read was not the plan that ran.',
  ].join(' '),
  stop_condition:
    'Stop once the import report is emitted. Do not triage, re-specify or start the imported work.',
  verify: {
    command_template: 'sdlc import --dry-run --json',
    done_criteria_ref: 'import#round-trip',
  },
  arguments: [
    {
      name: 'source',
      required: true,
      description:
        'The tool to import from, e.g. spec-kit. Use the id `sdlc import --dry-run` reports rather than a guess; detection names what it found.',
    },
  ],
  context_mode: 'inline',
});

/**
 * `pr` (FEAT-SKILL-014) — the narrative beside the evidence bundle.
 *
 * `sdlc pr` already renders the title, the branch and the recorded evidence,
 * deterministically, from the database. What it cannot write is why the change
 * was made and what a reviewer should look at hardest.
 *
 * **The hard rule is that this skill never characterises the evidence.** It does
 * not say the tests pass, does not summarise the bundle, does not restate the
 * gate result. `sdlc pr` prints whether the gate passes; a model writing "all
 * tests green" next to a machine-produced block is the self-report this whole
 * product exists to refuse, and it is *more* dangerous there than anywhere else,
 * because it is sitting inside a document whose other half is trustworthy.
 */
export const PR_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'pr',
  description:
    'Write the reviewer-facing half of a pull request — why the change was made and where to look — beside the evidence bundle `sdlc pr` renders.',
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/pr.yaml',
  role: [
    'You write the part of a pull request a reviewer reads before the diff: why this change exists,',
    'what approach it took, and which part deserves the most attention.',
    'You do NOT describe the test results, the gate outcome or the evidence — those are rendered from',
    'recorded runs by `sdlc pr`, and your account of them would be an opinion sitting beside a measurement.',
    'You do not merge, you do not approve, and you do not advance the stage.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#delivery',
  task: [
    'Write the PR narrative for {{work_item_id}}.',
    'Run `sdlc pr` to get the rendered title, branch and evidence bundle. Read it; do not repeat it.',
    'Say why the change was made, what approach it took and what was deliberately left out.',
    'Then name the riskiest part of the diff and say what a reviewer should check about it.',
    '"Please review carefully" tells a reviewer nothing; a specific file and a specific worry tells them where to start.',
  ].join(' '),
  output_contract: {
    tool_name: 'pr_output',
    json_schema_ref: 'schemas/pr-output.schema.json',
  },
  self_verification: [
    'Before emitting: check that no sentence you wrote makes a claim about whether the tests or the gate passed.',
    'If one does, delete it — that claim is rendered from recorded evidence, and yours would either agree redundantly or disagree wrongly.',
  ].join(' '),
  stop_condition:
    'Stop once the narrative is emitted. Do not open the pull request, do not push, do not merge, and do not advance the stage.',
  verify: {
    command_template: 'sdlc pr {{work_item_id}} --json',
    done_criteria_ref: 'work-item#done',
  },
  arguments: [{ name: 'work-item-id', required: true, description: WORK_ITEM_ID_ARG }],
  context_mode: 'inline',
});

/**
 * `release-notes` (FEAT-SKILL-015) — what changed, for the people it changed for.
 *
 * The one of the five with no command behind it: the audit found neither skill
 * nor command. Its inputs are the work items that reached `done` and the commits
 * between two refs, both already readable.
 *
 * **Every entry names the work item it came from.** Required, and it is the
 * whole design: release notes are the document most likely to acquire a line
 * nobody can trace, because the shape is so easy to imitate — a plausible
 * sentence about an improvement reads exactly like a real one. Requiring the id
 * makes the unsourced line impossible to write rather than merely discouraged.
 *
 * And notes are written in the user's terms, not the diff's. "Refactored the
 * assembly pipeline" is a changelog entry addressed to the person who already
 * knows, which is the one person who does not need it.
 */
export const RELEASE_NOTES_SKILL: CanonicalSkill = CanonicalSkillSchema.parse({
  schema_version: '0.1.0',
  name: 'release-notes',
  description:
    'Write release notes from the work items that actually shipped, with every entry traceable to one.',
  user_invoked: true,
  tier: 'medium',
  context_pack_spec_ref: 'context-packs/release-notes.yaml',
  role: [
    'You write release notes for the people who use this software, not for the people who wrote it.',
    'Every line you write comes from a work item that reached done in this range.',
    'You do not describe work in progress, you do not announce plans, you do not tag or publish anything,',
    'and you do not advance the stage of any work item you mention.',
  ].join(' '),
  constitution_excerpt_ref: 'constitution#delivery',
  task: [
    'Write the release notes for the range {{range}}.',
    'Start from the work items that reached done in it — `sdlc status --json` lists them and `sdlc show`',
    'reads one. Use the commit log to check the range, not to source the entries: a commit is a unit of',
    'work and an entry is a unit of change somebody noticed.',
    'Describe each change in the terms of the person affected by it, and say plainly when something',
    'breaks — a breaking change discovered after upgrading was not documented, whatever the file says.',
    'Anything that did not ship in this range does not appear, however nearly done it is.',
  ].join(' '),
  output_contract: {
    tool_name: 'release_notes_output',
    json_schema_ref: 'schemas/release-notes-output.schema.json',
  },
  self_verification: [
    'Before emitting: for every entry, name the work item id it came from.',
    'An entry you cannot source is one you wrote from the diff or from expectation, and it is the line',
    'that turns a changelog into something nobody checks against.',
  ].join(' '),
  stop_condition:
    'Stop once the notes are emitted. Do not tag a release, do not publish, and do not edit any work item.',
  verify: { command_template: 'sdlc status --json', done_criteria_ref: 'release#notes' },
  arguments: [
    {
      name: 'range',
      required: true,
      description:
        'The release range, as two git refs, e.g. v0.1.0..HEAD. Decides which work items count as shipped.',
    },
  ],
  context_mode: 'fork',
});

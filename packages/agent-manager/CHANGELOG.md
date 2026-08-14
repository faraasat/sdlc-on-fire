# @sdlc-on-fire/agent-manager

## 0.1.0-alpha.0

### Minor Changes

- First public prerelease.

  The walking skeleton runs end to end: `sdlc init` scaffolds a workspace with a
  zero-config local database, `sdlc new` creates a work item as Markdown with typed
  frontmatter, `sdlc verify` executes the item's own check and parses the real
  output, and `sdlc advance` refuses to move the item when that output says the
  check failed.

  Exit code 0 is not treated as "tests passed": a command with no machine-readable
  output records exit-code-only evidence at reduced confidence and prints how to
  fix it. Evidence is bound to a commit and a working-tree hash, so a run that
  passed against a different tree is reported stale rather than accepted.

  Also in this release: dependency install gate against live OSV advisories,
  secret and prompt-injection scanning, high-risk-surface review routing,
  branch-per-work-item git management with PR bodies rendered from recorded
  evidence, hard insertion with blast-radius analysis, selective gate re-open, and
  merge-conflict review that refuses a silently dropped side.

  Published under the `next` tag. Interfaces will change without warning before
  `0.1.0`; only the `sdlc` CLI is a supported surface.

### Patch Changes

- Updated dependencies
  - @sdlc-on-fire/core@0.1.0-alpha.0

## 0.1.0

### Minor Changes

- 576cec8: Add the stage-skill prompt template, the Claude Code compiler, `agents doctor`,
  and the CLI skeleton.

  `renderPrompt()` assembles a skill into its prompt in the fixed section order
  that _is_ the cache-boundary decision — stable sections first, so a repeat
  invocation reuses the cached prefix. Unresolved `{{slot}}` variables throw rather
  than reaching a model, where a literal `{{task_id}}` reads as "invent one".

  `ClaudeCodeAdapter` compiles a canonical skill to `.claude/skills/<name>/SKILL.md`
  deterministically — same input, byte-identical output, no model call. `runDoctor()`
  enforces capability-table totality, so a field like `allowed_tools` cannot be
  silently dropped by a target.

  The `sdlc` CLI ships `init`, `status`, `new`, and `config`, each with a `--json`
  twin that serializes the _same_ value the human path prints. `init` never
  overwrites an existing file and is safe to run twice.

- ee69146: Add `evaluateGate`, heading-aware chunking, and the two canonical stage skills.

  `evaluateGate()` is a pure function over its arguments, which is what makes a
  gate result replayable from the recorded evidence alone. Its outcome is
  three-way per requirement and never collapsed: `missing` means run the check,
  `failures` means fix the code. Two guarantees are structural rather than
  policy-driven — `agent-claim` evidence cannot satisfy any requirement no matter
  what a policy says, and evidence produced against a different commit or a
  different dirty tree is not evidence about this one.

  Markdown chunks carry their heading breadcrumb, because a retrieved chunk
  arrives with no surroundings and "it must be enabled first" is useless without
  knowing what _it_ is. Code chunks split at exported symbols and never mis-split:
  an unrecognised file comes back whole.

  The `spec` and `implement` skills ship as canonical source. Both forbid
  advancing the lifecycle from inside a skill, and `implement` explicitly forbids
  self-reporting test results — the daemon runs verify and reads the output.

- 91f9335: Initial monorepo scaffold: eight pnpm workspace packages (`core`, `storage`, `db`,
  `agent-manager`, `context`, `evidence`, `daemon`, `cli`) with strict TypeScript
  project references, tsup builds, Vitest, ESLint, Prettier, and Changesets.

  No user-facing behaviour yet — `sdlc-on-fire` ships its bin entry point but no
  commands. This is the substrate the rest of Phase 0 builds on.

- 6e14765: Add constitution compilation, gate persistence and replay, the review skill, and
  PR generation.

  `compileConstitution()` turns `evidence_enforced` principles into gate policies
  and reports what changed about enforcement. A principle marked enforced that
  names nothing checkable is reported as unsatisfiable rather than compiled into
  an empty policy that would pass trivially.

  `recordGate()` persists a verdict with its evidence links, and `replayGate()`
  recomputes it from those rows alone — which is what makes the record an audit
  trail rather than an assertion. Once HEAD moves, replay reports the evidence as
  stale instead of silently still passing.

  The `review` skill carries a HALT-on-zero-findings clause: a reviewer returning
  "looks good" on every diff is indistinguishable from one that never ran.

  PR bodies embed the evidence bundle — which commands ran, against which commit,
  and what they said. Stale evidence is shown as stale rather than filtered out,
  and `agent-claim` rows are labelled non-gating.

- 73fe836: Add the canonical skill IR and the `AgentAdapter` port.

  `@sdlc-on-fire/core` gains `CanonicalSkillSchema` — the one canonical skill
  source that compiles to every agent surface (ADR-0007). It enforces what the
  contract requires rather than documenting it: review-stage skills must declare
  `self_verification`, a tool cannot be both allowed and disallowed, arguments
  must be uniquely named with required ones first, and `tier` is a capability tier
  rather than a model id.

  `@sdlc-on-fire/agent-manager` gains the port itself, with no adapter-specific
  types. `missingCapabilityRows()` enforces the contract's totality requirement —
  every canonical field must be mapped, passed through, or explicitly dropped, so
  an adapter cannot silently compile away a field like `allowed_tools`.

- Walked the six v0.1 definition-of-done items by hand against the built binary,
  and fixed what that found — none of it visible to the test suite, which was
  green at 1340 tests throughout.

  - `sdlc skills doctor` and `sdlc skills compile` now exist. The Claude Code
    compiler, the capability table and the doctor had all shipped with tests, but
    nothing ever wired them to a command, so a user could not compile a skill at
    all.
  - Approving an agent's restated understanding now requires a human at a
    terminal. `echo approve --as agent` used to succeed and write "decided by:
    agent (human)" into the record — the one gate that breaks the
    agent-approves-itself circularity was satisfiable by the agent.
  - `sdlc advance` no longer deletes hand-written frontmatter from a git-tracked
    card. It serialized only the schema's known keys, so an ordinary transition
    destroyed every other field — including the `verify:` command the next gate
    then demanded by name.
  - `sdlc init` brings the database up instead of reporting success and deferring
    it, so a machine where the runtime cannot start says so at the setup step.
  - Compiled skills use the substitutions Claude Code actually performs
    (`$ARGUMENTS[N]`), and `arguments:` is emitted in the shape it actually reads.
    Both were silently wrong: the skill loaded and did nothing with its arguments.
  - `sdlc verify` names the remedy when evidence falls back to exit-code-only,
    instead of leaving a user at 0.6 confidence with no idea why.
  - New `@sdlc-on-fire/importers`: the parser port, tool-independent IR, and
    transactional dependency-ordered writer with `external_ref` idempotency.
    Groundwork for the migration path; no CLI command wires it yet.

- 5f47e62: Resolve the three open questions: task work type, doc-type schemas, agent dispatch.

  `REQUIRED_STAGES` stays keyed on `work_type`, and `task` is now a work type with
  a deliberately short ladder (ADR-0070). An atomic task was inheriting a feature's
  eight-stage ladder; under `standard` it now walks four.

  Adds the four deferred doc-type schemas — spec, change, decision, research —
  including the fixed delta application order, which decides what a change actually
  produces.

  Adds `dispatchSkill()`, the `invoke` leg the `AgentAdapter` was missing: the
  compiler wrote skills nobody ran. Dispatch fills the task template, enforces the
  output contract, and **rejects any output claiming its own tests passed** — the
  daemon runs verify, not the agent.

### Patch Changes

- Updated dependencies [4c2846b]
- Updated dependencies [91f9335]
- Updated dependencies [21c38e6]
- Updated dependencies [202238c]
- Updated dependencies [30d6e81]
- Updated dependencies [73fe836]
- Updated dependencies [5f47e62]
- Updated dependencies [14e0b52]
  - @sdlc-on-fire/core@0.1.0

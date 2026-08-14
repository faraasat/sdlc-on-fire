# @sdlc-on-fire/evidence

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
  - @sdlc-on-fire/db@0.1.0-alpha.0

## 0.1.0

### Minor Changes

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

- 30d6e81: Add preset classification, the evidence engine, and context pack assembly.

  `classifyPreset()` picks a lifecycle preset deterministically from work-item
  signals and always explains why. An explicit request is honoured but recorded as
  an override, and a weaker preset on high-risk work carries a warning — the
  reason list is what a reviewer reads later.

  `packages/evidence` turns real command output into typed evidence. The daemon
  runs the command; nothing here asks an agent what happened. A parser that cannot
  understand its input throws rather than manufacturing a plausible empty result,
  and a zero-test run is never reported as a pass.

  `assembleContextPack()` is the deterministic disposer for what enters a prompt.
  Truncation drops retrieval first, then optional layers, and never touches
  card-core — an agent given a partial task description will confidently do the
  wrong thing.

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

### Patch Changes

- b2d051a: Add the two invariant triggers, and an end-to-end walking-skeleton test.

  `approvals_agent_never_approves` and `gate_evidence_agent_claim_guard` were
  specified by contracts/01 as the deterministic disposers for two architecture §5
  invariants and had not been implemented. They exist because application-layer
  checks are not enough: a trigger fires regardless of what the daemon's own code
  does, so a bug in the daemon cannot let an agent approve its own work or gate on
  its own say-so.

  A new integration test runs the deterministic spine end to end — init, new, sync,
  daemon-run verify, gate blocked on real failure, lifecycle refusing to advance,
  fix, gate opening, lifecycle advancing, PR body — and asserts that an agent
  claiming success cannot open a gate.

- Updated dependencies [4c2846b]
- Updated dependencies [91f9335]
- Updated dependencies [21c38e6]
- Updated dependencies [77148ec]
- Updated dependencies [1b78d12]
- Updated dependencies [b2d051a]
- Updated dependencies [202238c]
- Updated dependencies [30d6e81]
- Updated dependencies [73fe836]
- Updated dependencies [5f47e62]
- Updated dependencies [14e0b52]
  - @sdlc-on-fire/core@0.1.0
  - @sdlc-on-fire/db@0.1.0

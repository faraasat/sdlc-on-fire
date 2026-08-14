# @sdlc-on-fire/daemon

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
  - @sdlc-on-fire/evidence@0.1.0-alpha.0
  - @sdlc-on-fire/context@0.1.0-alpha.0
  - @sdlc-on-fire/storage@0.1.0-alpha.0
  - @sdlc-on-fire/core@0.1.0-alpha.0
  - @sdlc-on-fire/db@0.1.0-alpha.0

## 0.1.0

### Minor Changes

- 4c2846b: Add the Markdown → DB sync engine.

  `SyncEngine` watches the managed tree (chokidar 5, `awaitWriteFinish` to absorb
  editor atomic-saves) and mirrors work items and docs into the database. Direction
  is one-way: content flows from git into the mirror, never back.

  The write-back-loop guard is a TTL-keyed `SelfWriteRegistry` rather than hash
  equality alone. Hash equality cannot distinguish the daemon's own write from an
  external edit that happens to produce identical bytes, and it misses an edit that
  lands between the disk write and the DB write — so self-writes are recorded
  explicitly and claimed once.

  `reconcile()` walks the tree at startup and reports a malformed file as a
  `failed` outcome instead of throwing, so one bad card cannot stop the rest of the
  workspace reaching the mirror.

  `@sdlc-on-fire/core` gains `contentHash()` and `canonicalJsonHash()` so every
  subsystem agrees on what "unchanged" means.

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

- 202238c: Add the adaptive lifecycle engine and task-spec wave resolver.

  `LifecycleEngine` runs the state machine over database rows rather than
  hard-coded branches: legal stages come from `REQUIRED_STAGES`, transitions are
  recorded in `lifecycle_transitions`, and `status` is derived as a Kanban
  projection on write. Transitions are forward-only and one step at a time —
  skipping a stage would let an item reach `done` without passing the gates on the
  stages in between.

  Guards are named async functions in a registry, so a refusal reports _which_
  guard refused. "Transition denied" with no name is unactionable.

  `resolveWaves()` groups tasks into dependency-ordered waves with disjoint file
  ownership (ADR-0041). Glob overlap detection is deliberately conservative: a
  false positive costs parallelism, a false negative costs a corrupted merge, and
  those are not symmetric. A task declaring no ownership makes no claim of safety
  and conflicts with everything.

- d78305c: Add the Git Manager: branch, worktree, commit, diff, and the bookkeeping split.

  `createGitManager()` wraps `simple-git` with the operations the daemon needs to
  drive branch-per-work-item and worktree-isolated waves. Branches and worktrees
  are created here rather than by hand, so a branch stays traceable to its work
  item without a lookup.

  `buildBranchName()` generates `<type>/<epic>-<feature>-<task-id>-<slug>` per
  ADR-0048, slugifying the hierarchy while preserving the task ID verbatim — the ID
  is the anchor `git log --grep` relies on.

  Commits classify their own change set: a commit touching only tool-managed paths
  (`kanban/`, `docs/`, `.sdlcof/`) automatically carries the `Sdlc-Bookkeeping: true`
  trailer, so product history can be filtered from workspace bookkeeping without a
  separate branch or ref. The classification is a deterministic rule, not a
  commit-message convention.

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

- Updated dependencies [ee69146]
- Updated dependencies [4c2846b]
- Updated dependencies [91f9335]
- Updated dependencies [6e14765]
- Updated dependencies [21c38e6]
- Updated dependencies [77148ec]
- Updated dependencies [1b78d12]
- Updated dependencies [b2d051a]
- Updated dependencies [202238c]
- Updated dependencies [30d6e81]
- Updated dependencies [68cba77]
- Updated dependencies [73fe836]
- Updated dependencies
- Updated dependencies [5f47e62]
- Updated dependencies [14e0b52]
  - @sdlc-on-fire/evidence@0.1.0
  - @sdlc-on-fire/context@0.1.0
  - @sdlc-on-fire/core@0.1.0
  - @sdlc-on-fire/storage@0.1.0
  - @sdlc-on-fire/db@0.1.0

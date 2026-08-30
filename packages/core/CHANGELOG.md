# @sdlc-on-fire/core

## 0.1.0-alpha.3

### Patch Changes

- 0751c2e: The completion pass, the trust instrumentation, and the fix for the first thing
  a stranger hit.

  **`sdlc init` no longer treats a mature repository like an empty one.**
  `0.1.0-alpha.2` wrote **28 files** into the root of every project it was pointed
  at — measured on flask, cobra, ripgrep and got, three of which have no Node
  toolchain at all. The fix landed one commit after alpha.2 was staged and has
  been sitting unpublished since: brownfield detection now writes **7 root files**,
  and the detection no longer assumes the JavaScript ecosystem, so a Rust or Go or
  Python tree is recognised as an existing project rather than a blank one.

  **Every stage has a real skill.** The shipped set goes from 5 to 21 — planning,
  research, delivery, triage, write-tests across all seven test tiers — with
  per-stage assembly profiles, token budgets and effort tiers, so a stage is
  given the context it needs rather than everything. `sdlc run` is the caller the
  dispatch layer never had; `sdlc instructions` names the current stage's skill
  rather than the next one's.

  **Runs are recorded.** `run` rows, the context pack a run was actually given,
  run history, backups, and `sdlc rollback` — the safe way off a work item, which
  preserves the abandoned tip under `refs/sdlcof/abandoned` before it deletes
  anything. A rollback that destroys the only copy of the work is not a rollback.

  **CI status is gate evidence, and only when it is finished.** A check that has
  not completed is not a passing check, and `success` is the only conclusion that
  counts as green — `neutral` and `skipped` cannot drift into meaning passed.

  **Metrics that say "not available" with a reason.** Gate pass rates,
  intervention counts, insertion churn, retrieval precision@k judged by a person,
  cache-hit rate, trajectory and blocked time.

  **New: instrumentation for whether the tool is actually working.** A held-out
  test suite the repair loop **structurally cannot read** — excluded at retrieval,
  at sync, at rebuild and in the agent's scope grant, with every leak surface
  enumerated rather than assumed — plus the visible-vs-held-out gap over time.
  Long runs get in-run context accounting, bounded compaction against a declared
  budget, and a deterministic degradation signal, because a long run stays fluent
  while it degrades. Visibility is reported with Wilson intervals throughout, and
  a trend is only called when the two intervals are disjoint: a line through two
  point estimates is a story drawn through noise.

  **New: four views the board was missing** — a lifecycle timeline, an agent-run
  viewer, a research index that leads with how much research nothing asked for,
  and a decision log that reports broken supersession chains instead of rendering
  them as a clean list.

  Also: `sdlc doctor`, `db:up`/`db:down`, errors that name the fix, `--json`
  emitting exactly one document on the failure path too, model fallback chains
  with a reviewer that is not the author, selective re-wave and insertion that
  respects an open PR, bug reports that a comment finally creates, risk records
  derived from the blast radius, and a stale model-id check that was wrong in both
  directions — it rejected every current top-tier model and accepted a retired
  alias.

## 0.1.0-alpha.2

### Patch Changes

- Brownfield `init`, honest exit codes, GitHub Issues sync, and READMEs that describe the product you actually use.

  **`init` no longer dumps 28 files into a mature repository.** Pointing the published `alpha.1` at flask, cobra, ripgrep and got showed every one of them receiving the full greenfield scaffold. A repo that already has a `README.md` and its own `docs/` now gets 7 root files instead of 28.

  **`init` no longer exits 0 when the database genuinely failed to start.** A script doing `sdlc init && sdlc verify …` was sailing straight past a workspace with no mirror. It now distinguishes a database merely _held_ by another `sdlc serve` — the most ordinary setup there is, still exit 0 — from one that actually failed, which exits 1.

  **Two-way GitHub Issues sync** (`sdlc tracker:sync`), live-verified against a real repository. Conflicts are refused rather than merged unless you name a policy, absence is never read as deletion, and pull requests are never mistaken for work items.

  **`sdlc db:up` is no longer suggested by error messages.** It was named in two remediation strings and registered nowhere — the text you read when you are already stuck pointed at a command that does not exist.

  **READMEs rewritten.** They described a CLI; the product is skills loaded in your agent's chat window. `@sdlc-on-fire/ui` had no README at all.

## 0.1.0-alpha.1

### Patch Changes

- Roles, a live board, and the fix for a defect that shipped in `0.1.0-alpha.0`.

  **`sdlc tiers` no longer claims a suite passed when it never ran one.** The
  published alpha printed `✓ unit — 1/1 unit tests passed` for tests it had only
  counted as files — the exact sentence this product exists to refuse from an
  agent, emitted by the product about a project it was pointed at. Discovery mode
  now reports `present — not run, so not passing`, and files alone can never
  satisfy a tier requirement.

  **The packages are composable rather than pinned together.** `workspace:*`
  published as an exact version, so `sdlc-on-fire@0.1.0-alpha.0` required
  `@sdlc-on-fire/core@0.1.0-alpha.0` exactly and every layer carried its own copy
  of core — adopting a second layer later installed a duplicate whose schemas and
  class identities disagreed with the first. Inter-layer dependencies are ranged
  now and `core` is a peer, so one copy is structural rather than lucky.

  **A layer becomes reachable by being installed.** Declare an `sdlc-on-fire` key
  in your own `package.json` and export `{ name, register }`; `npm install` is the
  whole adoption step. Discovery reads declared dependencies and never walks
  `node_modules`, so cloning a repository cannot execute code you never installed.

  **New: a board.** `sdlc serve` runs a read API, a live WebSocket and a React
  board on one loopback port. Cards move by drag through the same lifecycle guards
  `sdlc advance` uses — a drag is a proposal, and a refused move says why. Agents
  render visibly as agents, and their unbacked claims read as _proposal — pending
  evidence_.

  **New: metrics that refuse to flatter.** `sdlc metrics flow` reports per-stage
  time, the binding constraint, flow efficiency and rework. `sdlc metrics dora`
  reports all five DORA metrics together or not at all, and says _not available_
  with a reason rather than zero for anything it cannot compute.

  Also: realtime with reconnect catch-up, RBAC with quorum and revocation,
  evidence bound to the gates it satisfies, WIP limits derived from Little's Law,
  and a concurrency test tier.

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

- 21c38e6: Add the object model: Zod schemas and lifecycle data for the v0.1 artifact set.

  `@sdlc-on-fire/core` now exports the shapes every other package validates against
  — work items (epic/story/feature/bug/task), the constitution, evidence envelopes,
  runs, context packs, and rolling memory — plus the lifecycle vocabulary and the
  `REQUIRED_STAGES[preset][work_type]` resolution table.

  Zod is the single type source: every exported TypeScript type is a `z.infer` of a
  schema defined once here, never a hand-written interface duplicated downstream.

  Cross-field invariants are enforced as deterministic checks rather than
  documentation: `status` must be the Kanban projection of `lifecycle_state`, a
  work item's `lifecycle_state` must be on its resolved stage ladder, `supersedes`
  and `corrects` are mutually exclusive, and an item's ID prefix must match its
  kind. Evidence carries the two guarantees that cannot be phased in later —
  `producer: "agent-claim"` is structurally excluded from gating, and staleness is
  checked against the current commit and worktree.

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

- 14e0b52: Add the workspace layout and config schema.

  `@sdlc-on-fire/core` now owns the canonical workspace shape (ADR-0043,
  contracts/06): the eight-file root whitelist, the `docs/` topic-file set, the
  directories `init` creates eagerly versus lazily, and the gitignore entry that
  keeps the whole hidden state directory out of git.

  `WorkspaceConfigSchema` validates `.sdlcof/config.yaml`, rejecting two mistakes
  that would otherwise surface much later: connected mode with no `database.url`,
  and a path override that escapes the project root.

  `@sdlc-on-fire/db`'s `resolveWorkspacePaths` is now a thin re-export of core's
  `resolveWorkspaceLayout` rather than a second definition of the same paths.

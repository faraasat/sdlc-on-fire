# @sdlc-on-fire/core

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

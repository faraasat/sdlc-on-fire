# @sdlc-on-fire/db

## 0.1.0-alpha.2

### Patch Changes

- Brownfield `init`, honest exit codes, GitHub Issues sync, and READMEs that describe the product you actually use.

  **`init` no longer dumps 28 files into a mature repository.** Pointing the published `alpha.1` at flask, cobra, ripgrep and got showed every one of them receiving the full greenfield scaffold. A repo that already has a `README.md` and its own `docs/` now gets 7 root files instead of 28.

  **`init` no longer exits 0 when the database genuinely failed to start.** A script doing `sdlc init && sdlc verify …` was sailing straight past a workspace with no mirror. It now distinguishes a database merely _held_ by another `sdlc serve` — the most ordinary setup there is, still exit 0 — from one that actually failed, which exits 1.

  **Two-way GitHub Issues sync** (`sdlc tracker:sync`), live-verified against a real repository. Conflicts are refused rather than merged unless you name a policy, absence is never read as deletion, and pull requests are never mistaken for work items.

  **`sdlc db:up` is no longer suggested by error messages.** It was named in two remediation strings and registered nowhere — the text you read when you are already stuck pointed at a command that does not exist.

  **READMEs rewritten.** They described a CLI; the product is skills loaded in your agent's chat window. `@sdlc-on-fire/ui` had no README at all.

- Updated dependencies
  - @sdlc-on-fire/core@0.1.0-alpha.2

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

- Updated dependencies
  - @sdlc-on-fire/core@0.1.0-alpha.1

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

- 91f9335: Initial monorepo scaffold: eight pnpm workspace packages (`core`, `storage`, `db`,
  `agent-manager`, `context`, `evidence`, `daemon`, `cli`) with strict TypeScript
  project references, tsup builds, Vitest, ESLint, Prettier, and Changesets.

  No user-facing behaviour yet — `sdlc-on-fire` ships its bin entry point but no
  commands. This is the substrate the rest of Phase 0 builds on.

- 77148ec: Add the Drizzle schema and migrations for the v0.1 MVP table subset.

  `src/schema.ts` is the single source of truth; migrations are generated from it
  by drizzle-kit and never hand-edited. `applySchema()` applies them through a
  migration ledger, so running `db:up` on an existing workspace is a genuine no-op
  rather than a failed `CREATE TABLE`.

  Three things Drizzle's schema builder cannot express are applied separately and
  deliberately: the pgvector extension and HNSW index, the tsvector GIN indexes the
  v0.1 retrieval path uses, and `REVOKE UPDATE, DELETE ON audit_log` — a silently
  disappearing REVOKE is the one failure the hash-chained audit log cannot survive.

  `lifecycle_states` is seeded from core's canonical stage vocabulary, so a stage
  cannot exist in code but be missing from the database.

- 1b78d12: Add the PGlite provisioning fast path.

  `provisionPglite()` brings up the bundled PGlite database under `.sdlcof/db`,
  loads pgvector, and verifies the capabilities the schema depends on before
  returning a usable handle. PGlite is Postgres compiled to WebAssembly, so this
  ships no platform binaries and carries no per-OS build matrix (ADR-0068).

  Capabilities are probed, never assumed: pgvector is confirmed by reading
  `pg_extension` back after creating it, and HNSW by checking `pg_am`. A database
  that comes up but cannot do what the schema needs is rejected with a specific
  error rather than failing later at first query.

  Because PGlite is single-connection, the data directory is held under an advisory
  lock for the lifetime of the handle. A second process attempting to open the same
  directory gets a `DatabaseLockedError` instead of risking WAL corruption.

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

### Patch Changes

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

- Updated dependencies [4c2846b]
- Updated dependencies [91f9335]
- Updated dependencies [21c38e6]
- Updated dependencies [202238c]
- Updated dependencies [30d6e81]
- Updated dependencies [73fe836]
- Updated dependencies [5f47e62]
- Updated dependencies [14e0b52]
  - @sdlc-on-fire/core@0.1.0

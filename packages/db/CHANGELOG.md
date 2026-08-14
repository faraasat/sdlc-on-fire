# @sdlc-on-fire/db

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

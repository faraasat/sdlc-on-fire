# @sdlc-on-fire/importers

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
  - @sdlc-on-fire/storage@0.1.0-alpha.2

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
  - @sdlc-on-fire/storage@0.1.0-alpha.1
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
  - @sdlc-on-fire/storage@0.1.0-alpha.0
  - @sdlc-on-fire/core@0.1.0-alpha.0

## 0.1.0

### Minor Changes

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

- Updated dependencies [4c2846b]
- Updated dependencies [91f9335]
- Updated dependencies [21c38e6]
- Updated dependencies [202238c]
- Updated dependencies [30d6e81]
- Updated dependencies [68cba77]
- Updated dependencies [73fe836]
- Updated dependencies
- Updated dependencies [5f47e62]
- Updated dependencies [14e0b52]
  - @sdlc-on-fire/core@0.1.0
  - @sdlc-on-fire/storage@0.1.0

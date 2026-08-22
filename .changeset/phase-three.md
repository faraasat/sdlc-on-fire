---
'@sdlc-on-fire/agent-manager': patch
'@sdlc-on-fire/importers': patch
'@sdlc-on-fire/evidence': patch
'@sdlc-on-fire/context': patch
'@sdlc-on-fire/storage': patch
'@sdlc-on-fire/daemon': patch
'@sdlc-on-fire/core': patch
'@sdlc-on-fire/db': patch
'@sdlc-on-fire/ui': patch
'sdlc-on-fire': patch
---

Roles, a live board, and the fix for a defect that shipped in `0.1.0-alpha.0`.

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
render visibly as agents, and their unbacked claims read as *proposal — pending
evidence*.

**New: metrics that refuse to flatter.** `sdlc metrics flow` reports per-stage
time, the binding constraint, flow efficiency and rework. `sdlc metrics dora`
reports all five DORA metrics together or not at all, and says *not available*
with a reason rather than zero for anything it cannot compute.

Also: realtime with reconnect catch-up, RBAC with quorum and revocation,
evidence bound to the gates it satisfies, WIP limits derived from Little's Law,
and a concurrency test tier.

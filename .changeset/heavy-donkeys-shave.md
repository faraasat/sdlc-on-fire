---
'@sdlc-on-fire/agent-manager': minor
'@sdlc-on-fire/evidence': minor
'@sdlc-on-fire/storage': minor
'@sdlc-on-fire/context': minor
'@sdlc-on-fire/daemon': minor
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/db': minor
'sdlc-on-fire': minor
---

Initial monorepo scaffold: eight pnpm workspace packages (`core`, `storage`, `db`,
`agent-manager`, `context`, `evidence`, `daemon`, `cli`) with strict TypeScript
project references, tsup builds, Vitest, ESLint, Prettier, and Changesets.

No user-facing behaviour yet — `sdlc-on-fire` ships its bin entry point but no
commands. This is the substrate the rest of Phase 0 builds on.

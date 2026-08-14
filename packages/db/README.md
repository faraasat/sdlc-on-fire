# @sdlc-on-fire/db

**Drizzle schema, migrations, and the Postgres adapter behind the StoragePort.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

The database is a **rebuildable mirror**, never a source of truth for content. `sdlc db:rebuild` reconstructs every content-derived row from the Markdown in git; deleting the data directory loses nothing.

Two provisioning modes. PGlite is the zero-config default — it boots in-process with pgvector and HNSW indexes available, so a fresh workspace needs no Docker and no connection string. Connected mode accepts any Postgres-compatible endpoint by connection string and probes its capabilities rather than assuming them.

Everything above this package reaches data through `StoragePort` (defined in `@sdlc-on-fire/core`), so the database is swappable and no port ever imports an adapter.

## Install

```bash
npm install @sdlc-on-fire/db@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

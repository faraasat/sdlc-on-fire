# @sdlc-on-fire/importers

**Reads existing specs and plans from other agent tooling into the workspace.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

Supports OpenSpec, GitHub Spec Kit, GSD and BMAD source layouts. Each reader normalises into one intermediate representation before anything is written, so adding a format does not touch the writer.

Imported items keep an `external_ref` (source tool, path, content hash) alongside their own freshly assigned ID. That reference is an idempotency key — re-importing an unchanged source is a no-op rather than a duplicate — and never a substitute for the canonical ID.

The original source files are preserved untouched under `imported/`, so an import is always reviewable against what it read.

## Install

```bash
npm install @sdlc-on-fire/importers@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

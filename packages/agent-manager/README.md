# @sdlc-on-fire/agent-manager

**Canonical skills, the agent adapters they compile to, and tier routing.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

One canonical skill definition compiles to each agent surface's native format. Editing a compiled `.claude/skills/**` file is editing build output.

Every skill declares exactly one trigger: a lifecycle `stage`, or a `situation` for work that is not a stage at all — a merge conflict happens partway through `implement` and arrives without the stage changing.

Each skill carries a default capability tier resolved to a concrete model at dispatch, never a hardcoded model ID that goes stale on the next provider release. Subagent dispatch is isolated: the parent receives a bounded summary and a pointer to the full output on disk, so a subagent's context saving is not immediately spent pasting its transcript back.

## Install

```bash
npm install @sdlc-on-fire/agent-manager@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

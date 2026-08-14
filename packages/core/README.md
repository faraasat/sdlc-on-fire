# @sdlc-on-fire/core

**The object model: every shape the rest of the system agrees on.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

Zod is the single type source. Every exported TypeScript type here is a `z.infer` of a schema defined once in this package — never a hand-written interface duplicated downstream. `storage`, `db`, `daemon`, `evidence` and `context` all import their shapes from here, which is why a schema change breaks the build rather than surfacing as a runtime surprise three packages away.

It also holds the pure decision logic that has no business touching a filesystem: lifecycle stage tables, gate policy shapes, risk-surface detection, secret and prompt-injection patterns, licence classification, blast-radius analysis, and the merge-conflict classifier. All deterministic, all directly testable.

Notable exports: `WorkItemSchema`, `REQUIRED_STAGES`, `StoragePort`, `detectRiskSurfaces`, `scanForSecrets`, `classifyPackage`, `computeBlastRadius`, `classifyResolution`.

## Install

```bash
npm install @sdlc-on-fire/core@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

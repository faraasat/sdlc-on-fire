# @sdlc-on-fire/daemon

**Git manager, file watcher, sandboxing, and the security scanners.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

The git manager handles branch-per-work-item naming, worktree isolation, evidence-bearing commits, and the squash-and-sign pre-merge step. The watcher keeps the database mirror current with a content-hash guard, so the tool's own writes cannot trigger a sync loop.

Security adapters query the live OSV.dev advisory database and shell out to gitleaks where it is installed. Both distinguish "found nothing" from "could not reach the source" — an unreachable advisory API returning silence is indistinguishable from good news, and reading it as good news is how an outage becomes a false all-clear.

Tool output crossing into agent context is scanned, redacted, and fenced with a nonce, in that order.

## Install

```bash
npm install @sdlc-on-fire/daemon@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

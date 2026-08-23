# @sdlc-on-fire/daemon

Git operations, the file watcher, process sandboxing, and the security adapters. Two runtime dependencies: `chokidar` and `simple-git`.

> **Internal package, prerelease `0.1.0-alpha.2`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## The watcher cannot chase its own tail

The mirror is kept current by watching the tree, which means the tool's own writes would re-trigger it. A content-hash guard compares what changed against what was written, so a self-write is a no-op rather than a sync loop.

## Sandboxing kills the group, not the process

```ts
import { runGuarded } from '@sdlc-on-fire/daemon';

await runGuarded('pnpm', ['test'], { timeoutMs: 300_000, maxOutputBytes: 5_000_000 });
```

`pnpm test` spawns Vitest, which spawns workers. Killing only the process you launched leaves the real work running with its parent gone — a timeout that does not stop the runaway is not a timeout. On POSIX this is `process.kill(-pid)` against a detached group; on Windows, `taskkill /T /F`, because process groups do not exist there and the POSIX call fails silently.

## Security adapters that distinguish silence from good news

```ts
import { createOsvIntel, runGitleaks } from '@sdlc-on-fire/daemon';
```

Both return "could not reach the source" as a distinct state from "found nothing". An advisory API that is down returns an empty list, and reading that as an all-clear is how an outage becomes a false pass.

## Checkpoint and resume do not trust the log

A daemon dies mid-run — laptop sleep, OOM, `kill -9`. The question on restart is not _where did we get to_, which the log answers, but **is the log telling the truth**: a checkpoint saying step 7 committed is a claim written by the process that then crashed.

Resume reconciles the log against the worktree's actual HEAD, and a step whose claimed effect is not in the world is re-run rather than skipped. Checkpoints are semantic rather than per-turn — only a step that mutated state is a valid recovery point, so `mutates_state` is a column and recovery selects on it.

## Tool output crossing into agent context

Scanned, redacted, then fenced with a nonce — in that order. Redacting after fencing would fence the secret in.

## Licence

MIT.

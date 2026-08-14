# sdlc-on-fire

**A daemon that will not let the agent lie.**

Coding agents mark their own work done. They report that tests pass, that the change is complete, that the edge case is handled — and the report comes from the same process that wrote the code, with the same blind spots. When it is wrong, nothing downstream can tell.

This puts a process between the agent and "done". The agent writes the code. The tool runs the checks, reads the output, and decides whether the work item may move.

```console
$ sdlc advance TASK-001
TASK-001: BLOCKED at "implement" (wanted "test")
  ✗ gate: test failing evidence says the check did not pass — fix the code, then re-verify
```

> **Prerelease — `0.1.0-alpha.0`, published under the `next` tag.** Interfaces change without warning and several subsystems are unfinished. Worth trying; not worth building on yet.

## Install

```bash
npm install -g sdlc-on-fire@next
```

Node 20 or newer. `sdlc init` provisions a local PGlite database inside the workspace — no Docker, no connection string.

## A real run

Every block below is copied terminal output, not an illustration.

```console
$ sdlc init
Workspace initialised.
  root:    /tmp/demo
  created: 29 file(s)
  skipped: 0 existing file(s)
  db:      PGlite ready

$ sdlc new task "Add CSV export"
Created TASK-001 at /tmp/demo/kanban/_inbox/TASK-001.md
```

The card declares its own `verify:` command. The tool runs it and reads the output:

```console
$ sdlc verify TASK-001
TASK-001: passed (2/2 tests)
  command:  node --test --test-reporter=tap test.js
  exit:     0  (71ms)
  evidence: #2 recorded by the daemon, not claimed by an agent
```

**Exit 0 is not "tests passed", and it says so.** Point it at a command with no machine-readable output:

```console
$ sdlc verify TASK-001
TASK-001: exited 0 — no test report was parsed, so no test count was observed
  ⚠ no test count could be read — this is exit-code-only evidence (confidence 0.6).
    Add a machine-readable reporter to the verify command (e.g. `--reporter=json`
    for Vitest/Jest, or `--test-reporter=tap` for node:test) to record real counts.
```

Break the code and the gate closes. `advance` exits non-zero, so CI can depend on it:

```console
$ sdlc verify TASK-001
TASK-001: FAILED (exit 1)

$ sdlc advance TASK-001
TASK-001: BLOCKED at "implement" (wanted "test")
  ✗ gate: test failing evidence says the check did not pass — fix the code, then re-verify
```

Fix it, and the same command moves the item. Nothing was asked to reconsider; the evidence changed.

```console
$ sdlc verify TASK-001
TASK-001: passed (2/2 tests)

$ sdlc advance TASK-001
TASK-001: implement → test
```

Every command has a `--json` twin.

## Commands worth knowing

|                           |                                                                  |
| ------------------------- | ---------------------------------------------------------------- |
| `sdlc init`               | Scaffold a workspace. Never overwrites an existing file.         |
| `sdlc new <kind> <title>` | Create a work item as a Markdown file with typed frontmatter     |
| `sdlc verify <id>`        | Run the item's own verify command; record what actually happened |
| `sdlc advance <id>`       | Move to the next stage, if the guards and the gate allow it      |
| `sdlc queue`              | What can be worked on now, and what is waiting on what           |
| `sdlc pr <id>`            | A PR title and body rendered from the recorded evidence          |
| `sdlc deps check`         | Install gate: typosquats, licences, live OSV advisories          |
| `sdlc scan`               | Secrets and prompt-injection patterns across the workspace       |
| `sdlc conflicts`          | Lay out both sides of a merge conflict; check a resolution       |
| `sdlc instructions <id>`  | The next step, its skill prompt, and the assembled context       |

`sdlc --help` lists all of them — roughly forty.

## Design rules it actually enforces

- **Evidence is bound to a commit.** Edit a file after the suite passed and the evidence goes stale; the gate asks for a re-run rather than accepting a result describing code that is no longer there.
- **Markdown in git is the source of truth.** The database is a rebuildable mirror — `sdlc db:rebuild` reconstructs it from the files alone.
- **Agents are actors, never approvers.** Where a human sign-off is required, the check is on the actor's _kind_. A role can be granted to a service account; "is this a human" cannot be argued with.

## Not built yet

No UI (Kanban is a directory of Markdown files). No RBAC enforcement. No long-running background daemon — the CLI does the work in-process. Skills compile to Claude Code only so far. And it has not been validated outside its own repository.

Full detail, including the roadmap: [github.com/faraasat/sdlc-on-fire](https://github.com/faraasat/sdlc-on-fire).

## Licence

MIT.

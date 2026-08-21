# Release harness

Installs a **published** `sdlc-on-fire` from the npm registry into four real project shapes and drives it as a user would.

```bash
node scripts/release-harness/run.mjs                      # latest published
node scripts/release-harness/run.mjs --version 0.1.0-alpha.0
node scripts/release-harness/run.mjs --source local       # pack this workspace instead
node scripts/release-harness/run.mjs --scenario greenfield --keep
node scripts/release-harness/run.mjs --json report.json
```

## Why it is separate from `pnpm check`

Every test in the workspace imports from the workspace, where the eight sibling packages are simply _there_. That makes all of them structurally blind to packaging: the hard pin [P3-PKG-01] found existed only after `pnpm pack` rewrote `workspace:*` into an exact version, and only `npm install` from the registry reproduces it.

This needs the network, clones a large repository, and takes minutes, so it is a per-release step rather than a per-commit one.

## The four shapes

| Scenario             | Shape                       | What only it can catch                                                                                                                                                                              |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greenfield`         | from scratch                | The release does not work at all                                                                                                                                                                    |
| `invented-midstream` | from the middle             | Assumptions that hold only in a directory the product created itself                                                                                                                                |
| `oss-midstream`      | from the middle, real scale | A layout nobody here chose, and a `package.json` written years before this product existed. Pinned to `express@4.21.2` by commit, so a red result means _this release_ changed rather than upstream |
| `layer-extension`    | from scratch, then extended | A layer installed **after** the CLI is discovered and runs, with no release in between — and an undeclared package on disk is not executed (CWE-829)                                                |

## Reading the report

Three outcomes, deliberately distinct:

- **failed** — the release is wrong.
- **not in this release** — the capability is absent from the version under test. Detected by probing the installed binary's command list, not by comparing version numbers, so it stays honest against old releases without a hardcoded version going stale. Printed prominently; it is not a pass.
- **harness error** — a scenario threw. That is a bug _here_, and is labelled as one so that "the product is broken" and "the test is broken" never render identically.

`--source local` packs the workspace instead of downloading. It exists because publishing is irreversible and a harness you can only run afterwards reports history. The report records which source was used: **a local pass is weaker evidence than a registry pass**, and the two must never be confused in a release note.

## What it found on first run

Against the published `0.1.0-alpha.0`, `sdlc tiers` printed:

```
✓ unit — 1/1 unit tests passed
✓ integration — 1/1 integration tests passed
```

for suites it had never executed — it counted _files_ and rendered them through the run formatter. That is the [P2-QA-07] defect, fixed in the workspace and **not in the published release**. The same scenario passes under `--source local`. This is the finding the harness exists for: no test in this repo could have surfaced it, because the fix is present in the tree they all import from.

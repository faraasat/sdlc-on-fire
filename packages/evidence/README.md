# @sdlc-on-fire/evidence

**Runs the checks, parses what they printed, and evaluates the gate.**

> **Internal package, prerelease.** Published so that `sdlc-on-fire` installs resolve. It carries **no stability guarantee** before `0.1.0` — exports move and disappear between alpha releases. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

The verify command is executed **here**, by the tool, and its real output is parsed. An agent's assertion that tests pass never enters this path.

Gate verdicts are three-way and deliberately never collapsed to a boolean: `failures` means fix the code, `missing` means run the check, `abstained` means the verifier could not reach a conclusion. Collapsing them produces an agent editing code when the actual problem was a check that never executed.

Evidence is bound to a commit and a working-tree hash. A run that passed against a different tree is reported stale rather than accepted, because it describes code no longer on disk.

Parsers cover Vitest, Jest, node:test and TAP. A command with no machine-readable output still records evidence — at reduced confidence, labelled exit-code-only, with the fix printed.

## Install

```bash
npm install @sdlc-on-fire/evidence@next
```

Node 20 or newer. Part of [SDLC on Fire](https://github.com/faraasat/sdlc-on-fire) — a daemon that will not let the agent lie.

## Licence

MIT.

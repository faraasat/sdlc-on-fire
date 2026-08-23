# @sdlc-on-fire/agent-manager

Canonical skills, the six agent surfaces they compile to, and the tier routing that decides which model does what.

> **Internal package, prerelease `0.1.0-alpha.2`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## One skill definition, many targets

A skill is authored once as a canonical IR and compiled out. Claude Code and MCP are implemented; nothing else is.

```ts
import { ClaudeCodeAdapter, McpAdapter, CANONICAL_SKILLS } from '@sdlc-on-fire/agent-manager';

new McpAdapter().compileServer(CANONICAL_SKILLS);
// tools/list per MCP 2025-11-25 — inputSchema is always a JSON Schema object,
// even for a no-argument tool, because the spec says MUST and clients enforce it
```

The compiled output is not hand-edited. A skill that needs a Claude-Code-specific field carries it in the IR, so the two surfaces cannot drift into disagreeing about what the skill does.

## Tier routing, and the rule about who may not use it

```ts
import { resolveTier, dispatchSkill, verifyLowTierOutput } from '@sdlc-on-fire/agent-manager';
```

Work is routed by cost and risk: low tier for high-volume verifiable narrow work, medium by default, high rarely. `MAX_CONCURRENCY` (8) and `MAX_RECURSION_DEPTH` (2) are enforced in `@sdlc-on-fire/daemon`'s governor, and `verifyLowTierOutput` schema- or rubric-checks cheap output before it is trusted — the point of a cheap tier is that it is cheap _and verified_, not cheap and believed.

## Trajectory evaluation, where the judge is not the disposer

Every other gate judges an artifact. `trajectory-eval` judges the **path** — whether the orchestrator decomposed sensibly, whether the reviewer looked where the bug was.

The obvious harness for that is an LLM judge, and it is the harness this project is least entitled to trust. So a human-labelled **golden set** is the disposer: the judge is run against it first, and its agreement rate is its licence. Below the floor, its verdicts on unseen trajectories are not reported as verdicts at all. Disagreements are mined into the set rather than discarded, which is the only way it gets harder instead of staler.

## Windows spawning

`windowsSpawn()` exists because Node has refused to spawn `.cmd` and `.bat` without a shell since CVE-2024-27980, which meant the Claude CLI could not be invoked on Windows at all. It routes through `cmd.exe /d /s /c` explicitly rather than setting `shell: true`, which would hand the prompt to a command interpreter.

## Licence

MIT.

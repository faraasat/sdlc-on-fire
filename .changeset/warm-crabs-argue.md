---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/agent-manager': minor
'@sdlc-on-fire/daemon': patch
---

Resolve the three open questions: task work type, doc-type schemas, agent dispatch.

`REQUIRED_STAGES` stays keyed on `work_type`, and `task` is now a work type with
a deliberately short ladder (ADR-0070). An atomic task was inheriting a feature's
eight-stage ladder; under `standard` it now walks four.

Adds the four deferred doc-type schemas — spec, change, decision, research —
including the fixed delta application order, which decides what a change actually
produces.

Adds `dispatchSkill()`, the `invoke` leg the `AgentAdapter` was missing: the
compiler wrote skills nobody ran. Dispatch fills the task template, enforces the
output contract, and **rejects any output claiming its own tests passed** — the
daemon runs verify, not the agent.

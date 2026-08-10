---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/evidence': minor
'@sdlc-on-fire/context': minor
---

Add preset classification, the evidence engine, and context pack assembly.

`classifyPreset()` picks a lifecycle preset deterministically from work-item
signals and always explains why. An explicit request is honoured but recorded as
an override, and a weaker preset on high-risk work carries a warning — the
reason list is what a reviewer reads later.

`packages/evidence` turns real command output into typed evidence. The daemon
runs the command; nothing here asks an agent what happened. A parser that cannot
understand its input throws rather than manufacturing a plausible empty result,
and a zero-test run is never reported as a pass.

`assembleContextPack()` is the deterministic disposer for what enters a prompt.
Truncation drops retrieval first, then optional layers, and never touches
card-core — an agent given a partial task description will confidently do the
wrong thing.

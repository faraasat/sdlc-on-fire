---
'@sdlc-on-fire/evidence': minor
'@sdlc-on-fire/context': minor
'@sdlc-on-fire/agent-manager': minor
---

Add `evaluateGate`, heading-aware chunking, and the two canonical stage skills.

`evaluateGate()` is a pure function over its arguments, which is what makes a
gate result replayable from the recorded evidence alone. Its outcome is
three-way per requirement and never collapsed: `missing` means run the check,
`failures` means fix the code. Two guarantees are structural rather than
policy-driven — `agent-claim` evidence cannot satisfy any requirement no matter
what a policy says, and evidence produced against a different commit or a
different dirty tree is not evidence about this one.

Markdown chunks carry their heading breadcrumb, because a retrieved chunk
arrives with no surroundings and "it must be enabled first" is useless without
knowing what *it* is. Code chunks split at exported symbols and never mis-split:
an unrecognised file comes back whole.

The `spec` and `implement` skills ship as canonical source. Both forbid
advancing the lifecycle from inside a skill, and `implement` explicitly forbids
self-reporting test results — the daemon runs verify and reads the output.

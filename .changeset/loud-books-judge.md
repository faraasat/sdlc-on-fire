---
'@sdlc-on-fire/evidence': minor
'@sdlc-on-fire/agent-manager': minor
'@sdlc-on-fire/daemon': minor
---

Add constitution compilation, gate persistence and replay, the review skill, and
PR generation.

`compileConstitution()` turns `evidence_enforced` principles into gate policies
and reports what changed about enforcement. A principle marked enforced that
names nothing checkable is reported as unsatisfiable rather than compiled into
an empty policy that would pass trivially.

`recordGate()` persists a verdict with its evidence links, and `replayGate()`
recomputes it from those rows alone — which is what makes the record an audit
trail rather than an assertion. Once HEAD moves, replay reports the evidence as
stale instead of silently still passing.

The `review` skill carries a HALT-on-zero-findings clause: a reviewer returning
"looks good" on every diff is indistinguishable from one that never ran.

PR bodies embed the evidence bundle — which commands ran, against which commit,
and what they said. Stale evidence is shown as stale rather than filtered out,
and `agent-claim` rows are labelled non-gating.

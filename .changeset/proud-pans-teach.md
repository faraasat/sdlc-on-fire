---
'@sdlc-on-fire/db': minor
'@sdlc-on-fire/evidence': patch
---

Add the two invariant triggers, and an end-to-end walking-skeleton test.

`approvals_agent_never_approves` and `gate_evidence_agent_claim_guard` were
specified by contracts/01 as the deterministic disposers for two architecture §5
invariants and had not been implemented. They exist because application-layer
checks are not enough: a trigger fires regardless of what the daemon's own code
does, so a bug in the daemon cannot let an agent approve its own work or gate on
its own say-so.

A new integration test runs the deterministic spine end to end — init, new, sync,
daemon-run verify, gate blocked on real failure, lifecycle refusing to advance,
fix, gate opening, lifecycle advancing, PR body — and asserts that an agent
claiming success cannot open a gate.

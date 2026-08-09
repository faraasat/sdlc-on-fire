---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/agent-manager': minor
---

Add the canonical skill IR and the `AgentAdapter` port.

`@sdlc-on-fire/core` gains `CanonicalSkillSchema` — the one canonical skill
source that compiles to every agent surface (ADR-0007). It enforces what the
contract requires rather than documenting it: review-stage skills must declare
`self_verification`, a tool cannot be both allowed and disallowed, arguments
must be uniquely named with required ones first, and `tier` is a capability tier
rather than a model id.

`@sdlc-on-fire/agent-manager` gains the port itself, with no adapter-specific
types. `missingCapabilityRows()` enforces the contract's totality requirement —
every canonical field must be mapped, passed through, or explicitly dropped, so
an adapter cannot silently compile away a field like `allowed_tools`.

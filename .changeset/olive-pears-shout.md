---
'@sdlc-on-fire/core': minor
---

Add the object model: Zod schemas and lifecycle data for the v0.1 artifact set.

`@sdlc-on-fire/core` now exports the shapes every other package validates against
— work items (epic/story/feature/bug/task), the constitution, evidence envelopes,
runs, context packs, and rolling memory — plus the lifecycle vocabulary and the
`REQUIRED_STAGES[preset][work_type]` resolution table.

Zod is the single type source: every exported TypeScript type is a `z.infer` of a
schema defined once here, never a hand-written interface duplicated downstream.

Cross-field invariants are enforced as deterministic checks rather than
documentation: `status` must be the Kanban projection of `lifecycle_state`, a
work item's `lifecycle_state` must be on its resolved stage ladder, `supersedes`
and `corrects` are mutually exclusive, and an item's ID prefix must match its
kind. Evidence carries the two guarantees that cannot be phased in later —
`producer: "agent-claim"` is structurally excluded from gating, and staleness is
checked against the current commit and worktree.

---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/daemon': minor
---

Add the adaptive lifecycle engine and task-spec wave resolver.

`LifecycleEngine` runs the state machine over database rows rather than
hard-coded branches: legal stages come from `REQUIRED_STAGES`, transitions are
recorded in `lifecycle_transitions`, and `status` is derived as a Kanban
projection on write. Transitions are forward-only and one step at a time —
skipping a stage would let an item reach `done` without passing the gates on the
stages in between.

Guards are named async functions in a registry, so a refusal reports *which*
guard refused. "Transition denied" with no name is unactionable.

`resolveWaves()` groups tasks into dependency-ordered waves with disjoint file
ownership (ADR-0041). Glob overlap detection is deliberately conservative: a
false positive costs parallelism, a false negative costs a corrupted merge, and
those are not symmetric. A task declaring no ownership makes no claim of safety
and conflicts with everything.

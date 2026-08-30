---
'@sdlc-on-fire/agent-manager': patch
'@sdlc-on-fire/importers': patch
'@sdlc-on-fire/evidence': patch
'@sdlc-on-fire/context': patch
'@sdlc-on-fire/storage': patch
'@sdlc-on-fire/daemon': patch
'@sdlc-on-fire/core': patch
'@sdlc-on-fire/db': patch
'@sdlc-on-fire/ui': patch
'sdlc-on-fire': patch
---

The completion pass, the trust instrumentation, and the fix for the first thing
a stranger hit.

**`sdlc init` no longer treats a mature repository like an empty one.**
`0.1.0-alpha.2` wrote **28 files** into the root of every project it was pointed
at — measured on flask, cobra, ripgrep and got, three of which have no Node
toolchain at all. The fix landed one commit after alpha.2 was staged and has
been sitting unpublished since: brownfield detection now writes **7 root files**,
and the detection no longer assumes the JavaScript ecosystem, so a Rust or Go or
Python tree is recognised as an existing project rather than a blank one.

**Every stage has a real skill.** The shipped set goes from 5 to 21 — planning,
research, delivery, triage, write-tests across all seven test tiers — with
per-stage assembly profiles, token budgets and effort tiers, so a stage is
given the context it needs rather than everything. `sdlc run` is the caller the
dispatch layer never had; `sdlc instructions` names the current stage's skill
rather than the next one's.

**Runs are recorded.** `run` rows, the context pack a run was actually given,
run history, backups, and `sdlc rollback` — the safe way off a work item, which
preserves the abandoned tip under `refs/sdlcof/abandoned` before it deletes
anything. A rollback that destroys the only copy of the work is not a rollback.

**CI status is gate evidence, and only when it is finished.** A check that has
not completed is not a passing check, and `success` is the only conclusion that
counts as green — `neutral` and `skipped` cannot drift into meaning passed.

**Metrics that say "not available" with a reason.** Gate pass rates,
intervention counts, insertion churn, retrieval precision@k judged by a person,
cache-hit rate, trajectory and blocked time.

**New: instrumentation for whether the tool is actually working.** A held-out
test suite the repair loop **structurally cannot read** — excluded at retrieval,
at sync, at rebuild and in the agent's scope grant, with every leak surface
enumerated rather than assumed — plus the visible-vs-held-out gap over time.
Long runs get in-run context accounting, bounded compaction against a declared
budget, and a deterministic degradation signal, because a long run stays fluent
while it degrades. Visibility is reported with Wilson intervals throughout, and
a trend is only called when the two intervals are disjoint: a line through two
point estimates is a story drawn through noise.

**New: four views the board was missing** — a lifecycle timeline, an agent-run
viewer, a research index that leads with how much research nothing asked for,
and a decision log that reports broken supersession chains instead of rendering
them as a clean list.

Also: `sdlc doctor`, `db:up`/`db:down`, errors that name the fix, `--json`
emitting exactly one document on the failure path too, model fallback chains
with a reviewer that is not the author, selective re-wave and insertion that
respects an open PR, bug reports that a comment finally creates, risk records
derived from the blast radius, and a stale model-id check that was wrong in both
directions — it rejected every current top-tier model and accepted a retired
alias.

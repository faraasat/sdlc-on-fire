---
'@sdlc-on-fire/core': minor
'@sdlc-on-fire/daemon': minor
---

Add the Markdown → DB sync engine.

`SyncEngine` watches the managed tree (chokidar 5, `awaitWriteFinish` to absorb
editor atomic-saves) and mirrors work items and docs into the database. Direction
is one-way: content flows from git into the mirror, never back.

The write-back-loop guard is a TTL-keyed `SelfWriteRegistry` rather than hash
equality alone. Hash equality cannot distinguish the daemon's own write from an
external edit that happens to produce identical bytes, and it misses an edit that
lands between the disk write and the DB write — so self-writes are recorded
explicitly and claimed once.

`reconcile()` walks the tree at startup and reports a malformed file as a
`failed` outcome instead of throwing, so one bad card cannot stop the rest of the
workspace reaching the mirror.

`@sdlc-on-fire/core` gains `contentHash()` and `canonicalJsonHash()` so every
subsystem agrees on what "unchanged" means.

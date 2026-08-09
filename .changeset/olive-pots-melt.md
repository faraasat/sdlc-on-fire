---
'@sdlc-on-fire/db': minor
---

Add the Drizzle schema and migrations for the v0.1 MVP table subset.

`src/schema.ts` is the single source of truth; migrations are generated from it
by drizzle-kit and never hand-edited. `applySchema()` applies them through a
migration ledger, so running `db:up` on an existing workspace is a genuine no-op
rather than a failed `CREATE TABLE`.

Three things Drizzle's schema builder cannot express are applied separately and
deliberately: the pgvector extension and HNSW index, the tsvector GIN indexes the
v0.1 retrieval path uses, and `REVOKE UPDATE, DELETE ON audit_log` — a silently
disappearing REVOKE is the one failure the hash-chained audit log cannot survive.

`lifecycle_states` is seeded from core's canonical stage vocabulary, so a stage
cannot exist in code but be missing from the database.

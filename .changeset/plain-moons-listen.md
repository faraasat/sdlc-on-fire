---
'@sdlc-on-fire/db': minor
---

Add the PGlite provisioning fast path.

`provisionPglite()` brings up the bundled PGlite database under `.sdlcof/db`,
loads pgvector, and verifies the capabilities the schema depends on before
returning a usable handle. PGlite is Postgres compiled to WebAssembly, so this
ships no platform binaries and carries no per-OS build matrix (ADR-0068).

Capabilities are probed, never assumed: pgvector is confirmed by reading
`pg_extension` back after creating it, and HNSW by checking `pg_am`. A database
that comes up but cannot do what the schema needs is rejected with a specific
error rather than failing later at first query.

Because PGlite is single-connection, the data directory is held under an advisory
lock for the lifetime of the handle. A second process attempting to open the same
directory gets a `DatabaseLockedError` instead of risking WAL corruption.

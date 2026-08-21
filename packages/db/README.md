# @sdlc-on-fire/db

Drizzle schema, migrations, and the Postgres adapter behind `StoragePort`. Runs on PGlite in-process by default; talks to any Postgres by connection string when you point it at one.

> **Internal package, prerelease `0.1.0-alpha.0`.** Published so `sdlc-on-fire` installs resolve. No stability guarantee before `0.1.0` — exports move and disappear between alphas. The supported surface is the [`sdlc-on-fire`](https://www.npmjs.com/package/sdlc-on-fire) CLI.

## The database is a mirror, not a source of truth

`sdlc db:rebuild` drops every content-derived row and reconstructs it from the Markdown in git. Deleting `.sdlcof/db/` loses nothing that git does not still have.

What is _not_ rebuildable is deliberately outside what `resetMirror` touches: evidence, gates, approvals and the audit log are records of things that happened, and git does not hold them.

## Two provisioning modes

```ts
import { provisionPglite, connectToPostgres, applySchema } from '@sdlc-on-fire/db';

const db = await provisionPglite({ workspaceRoot: root }); // no Docker, no URL
await applySchema(db); // idempotent; also seeds
```

PGlite boots in-process with pgvector and HNSW available. Connected mode probes the endpoint's capabilities rather than assuming them — a Postgres without `vector` is reported as such instead of failing on the first embedding write.

## What `applySchema` does beyond the migration

drizzle-kit generates the tables from `src/schema.ts` and is never hand-edited. Everything the schema builder cannot express lives in `SUPPLEMENTAL_DDL`, because drizzle-kit would drop it on the next `generate` — and a silently disappearing `REVOKE` is not survivable for an audit chain.

That includes the generated `tsvector` columns (measured at 1,566 ms → **68 ms** for the same ranked result set over 50k rows, which is why they are stored rather than computed per read), the HNSW index parameters, and the invariant triggers.

## The triggers are the point

```sql
-- agents are actors, never approvers
CREATE TRIGGER approvals_agent_never_approves_trg BEFORE INSERT ON approvals …
-- and they cannot hold the role in the first place
CREATE TRIGGER memberships_agents_hold_no_roles_trg BEFORE INSERT OR UPDATE ON memberships …
```

Both, not one. The second makes the _state_ unreachable; the first still stands for a row that arrives through a restore. CHECK constraints cannot subquery, so these are triggers.

`comment_role_effects` is seeded total and refuses UPDATE outright: an edit there would silently re-point every future insert, which is the prompt-injection vector moved one table over.

## Licence

MIT.

# Database migrations: the expand-contract checklist

> P2-SKILL-06 · pairs with the `migrate` work type (P2-LIFE-02) · checked by `validateMigrationPlan`

## The shape

Three phases, three separate deploys. Never two of them at once.

| Phase        | What it does                                                     | Reversible?               |
| ------------ | ---------------------------------------------------------------- | ------------------------- |
| **Expand**   | Add the new structure alongside the old. Old code keeps working. | Yes — drop what you added |
| **Backfill** | Copy the data. Write to both.                                    | Yes — stop the job        |
| **Contract** | Remove the old structure.                                        | **No**                    |

That last cell is the whole reason for the ceremony. A `migrate` work item can be
rolled back at any point up to its contract phase and at no point after it.

## Why not do it in one migration

Because there is then no moment at which both the old and new structure work —
and deploys are not atomic. The instance still running the previous release will
write to a column the migration just dropped. The intermediate state isn't
overhead you're tolerating; it's the entire mechanism.

If you take one thing: **the deploy that stops using the old column and the
migration that drops it must be different deploys, with time in between.**

## Expand

- [ ] New structure is **additive only** — nothing existing is altered or dropped
- [ ] New columns are nullable, or have a default that does not rewrite the table
- [ ] Old code paths still work untouched, verified by running the existing suite against the migrated schema
- [ ] **A written rollback.** Usually "drop the new column; nothing reads it yet"

Adding a `NOT NULL` column with a default rewrites the whole table on older
Postgres. Check your version's behaviour before assuming it's instant.

## Backfill

- [ ] **Batched.** 1,000–10,000 rows per batch
- [ ] **A pause between batches.** At least 50ms
- [ ] **Resumable** — it will be interrupted, and restarting from zero on a large table means it never finishes
- [ ] Writes go to **both** old and new structure for the duration
- [ ] **Timed against a realistic row count**, recorded in the plan

Both batch bounds matter. Too large holds locks and bloats replication lag. Too
small and you have a job still running the next morning — which is a job
somebody kills halfway, leaving the half-migrated state permanently instead of
temporarily.

**Dev-DB timing tells you nothing.** A backfill that takes four seconds against
200 seeded rows can take nine hours against 40 million. The number nobody wrote
down is the number nobody measured, which is why the checker blocks a backfill
plan with no row count.

## Contract

This is the irreversible one. It gets a higher bar and its own work item.

- [ ] **Evidence** the old structure is unreferenced — a query against
      `pg_stat_statements`, a grep across every service, a dashboard showing zero
      reads over a fortnight. Something checkable
- [ ] The **expand work item** is named, and it shipped long enough ago that every
      instance has cycled
- [ ] Backups verified — not "backups exist", verified _restorable_
- [ ] Shipped **alone**, not alongside another schema change

There is deliberately no rollback line. Asking for one invites an answer, and
any answer would be false: the data is gone. "Restore from backup" is an
incident, not a rollback.

## What the tooling does

`migrate` is a work type, not a label ([P2-LIFE-02](../packages/core/src/lifecycle.ts)):

- **Full regression regardless of what the diff touched.** A column rename breaks
  every query in the system and not one of those files appears in the diff, so
  selective test re-run cannot see it.
- **A `plan` stage in every preset**, including `lite`. The rollback path has to
  be written while writing it is still cheap.
- **`security_review` under `strict`** — a migration is a high-risk surface.

`validateMigrationPlan` checks a plan before it runs, with two severities:
`blocking` means the pattern requires something that isn't there; `review` means
a number looks off for reasons that depend on the table, and only you know the
table.

## What this does not cover

Online schema-change tooling (`pg_repack`, `gh-ost`) and logical-replication
cutovers. Both are real answers to migrations too large for a batched backfill,
and neither is modelled here. If a backfill's measured time against a realistic
row count is measured in days, this checklist is the wrong tool and you want one
of those.

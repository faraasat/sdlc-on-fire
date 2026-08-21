/**
 * Realtime change events (P3-RT-01, contract 01 §3.11).
 *
 * A row changed in the database and something watching should look again. That
 * is the whole content of an event, and the restraint is deliberate: three
 * properties of Postgres `NOTIFY` make anything richer a defect waiting to
 * happen, and all three are documented rather than discovered.
 *
 * 1. **The payload is capped at 8000 bytes** in the default configuration. A
 *    row is not guaranteed to fit. An identifier always is.
 * 2. **Identical payloads inside one transaction collapse to a single
 *    delivery.** A consumer that counted events would undercount; a consumer
 *    that re-queries cannot tell the difference.
 * 3. **Delivery happens on commit, and only to sessions currently listening.**
 *    An aborted transaction sends nothing — confirmed against PGlite, where a
 *    rolled-back insert produced no notification. Nothing is kept for a
 *    listener that is absent.
 *
 * Property 3 is the one with teeth, and it is why {@link catchUpQuery} exists.
 * A client that was disconnected is told nothing on reconnect; it has to ask.
 * A realtime layer without that catch-up is not eventually consistent, it is
 * *silently* inconsistent — the board looks fine and is wrong, which is the
 * worst available failure mode for a tool whose product claim is that it will
 * not let you believe something untrue.
 */

import { z } from 'zod';

/** One channel for every table. Subscribers filter; the database does not. */
export const CHANGE_CHANNEL = 'sdlcof_change';

/**
 * A table watched for realtime, and the monotonic column catch-up reads.
 *
 * The watermark is not cosmetic. `WHERE <watermark> > $since` is the only way a
 * reconnecting client can discover what it missed, so a table without a
 * monotonic column cannot be reconciled *at all* — its missed updates are
 * unreachable by any query. `gates` and `runs` had no such column until this
 * task added one, which is why they are called out in the contract.
 */
export const WATCHED_TABLES = [
  { table: 'work_items', watermark: 'updated_at', appendOnly: false },
  { table: 'docs', watermark: 'updated_at', appendOnly: false },
  { table: 'gates', watermark: 'updated_at', appendOnly: false },
  { table: 'runs', watermark: 'updated_at', appendOnly: false },
  // Editable: only `role_effect` is frozen (ADR-0012), so the body can change
  // and `created_at` cannot serve as the watermark.
  { table: 'comments', watermark: 'updated_at', appendOnly: false },
  // Append-only: a row never changes after insert, so creation time *is* the
  // watermark and no `updated_at` is needed or meaningful.
  { table: 'lifecycle_transitions', watermark: 'created_at', appendOnly: true },
] as const;

export type WatchedTable = (typeof WATCHED_TABLES)[number]['table'];

/** The table names, as a plain set for membership tests. */
export const WATCHED_TABLE_NAMES: readonly string[] = WATCHED_TABLES.map((entry) => entry.table);

export function watermarkFor(table: string): string | null {
  return WATCHED_TABLES.find((entry) => entry.table === table)?.watermark ?? null;
}

export const CHANGE_OPS = ['INSERT', 'UPDATE', 'DELETE'] as const;
export type ChangeOp = (typeof CHANGE_OPS)[number];

export const ChangeEventSchema = z.object({
  table: z.string().min(1),
  id: z.string().min(1),
  op: z.enum(CHANGE_OPS),
  /** The row's watermark at the moment of the change, ISO-8601. */
  updated_at: z.string().min(1),
});

export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

/**
 * Parse a raw notification payload.
 *
 * Returns `null` rather than throwing, and that is load-bearing: the payload
 * crosses a process boundary from a database that other tools may also write
 * to. A malformed or unexpected notification must degrade one event, never take
 * down the subscriber that would have delivered the next thousand.
 */
export function parseChangeEvent(payload: string): ChangeEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = ChangeEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  // An event about a table nobody watches is not an error, but it is not ours.
  if (!WATCHED_TABLE_NAMES.includes(parsed.data.table)) return null;
  return parsed.data;
}

/** What a connected client asked to hear about. */
export interface Subscription {
  /** Tables of interest. Empty or absent means every watched table. */
  readonly tables?: readonly string[];
  /** Work-item ids of interest. Empty or absent means all of them. */
  readonly ids?: readonly string[];
}

/**
 * Whether an event should be delivered to a subscription.
 *
 * Absent means "everything", not "nothing". The opposite default would make a
 * client that subscribed without arguments silently receive nothing at all,
 * which reads as a dead connection rather than as a filter.
 */
export function matchesSubscription(event: ChangeEvent, subscription: Subscription): boolean {
  const { tables, ids } = subscription;
  if (tables !== undefined && tables.length > 0 && !tables.includes(event.table)) return false;
  if (ids !== undefined && ids.length > 0 && !ids.includes(event.id)) return false;
  return true;
}

/** A catch-up query: the SQL and its parameters, for a caller to execute. */
export interface CatchUpQuery {
  readonly table: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The reconnect-and-reconcile query for one table.
 *
 * Strictly greater than `since`, not greater-or-equal. The client's watermark is
 * the timestamp of something it has already seen; `>=` would redeliver it on
 * every reconnect, and a reconnect loop would then re-emit the same row forever.
 *
 * The table name is interpolated because a table name cannot be a bind
 * parameter in Postgres — so it is checked against {@link WATCHED_TABLES} and
 * refused if it is not one of them, rather than trusted. This function returns
 * `null` for an unknown table instead of building SQL from it.
 */
export function catchUpQuery(table: string, since: string, limit = 500): CatchUpQuery | null {
  const watermark = watermarkFor(table);
  if (watermark === null) return null;
  return {
    table,
    sql:
      `SELECT * FROM ${table} WHERE ${watermark} > $1 ` +
      `ORDER BY ${watermark} ASC LIMIT ${String(Math.max(1, Math.floor(limit)))};`,
    params: [since],
  };
}

/** Catch-up across every watched table, for a client that has been away. */
export function catchUpQueries(since: string, limit = 500): readonly CatchUpQuery[] {
  return WATCHED_TABLES.map((entry) => catchUpQuery(entry.table, since, limit)).filter(
    (query): query is CatchUpQuery => query !== null,
  );
}

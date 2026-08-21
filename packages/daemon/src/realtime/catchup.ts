/**
 * Reconnect-and-reconcile (P3-RT-01).
 *
 * This is the part that makes realtime *correct* rather than merely fast.
 * Postgres `NOTIFY` delivers only to sessions listening at the moment of
 * commit, and keeps nothing for anyone absent. A client that drops its
 * connection for two seconds is told nothing about those two seconds when it
 * returns — so unless it asks, its view is silently stale, and a board that is
 * quietly wrong is a worse outcome for this product than one that is visibly
 * broken.
 */

import { catchUpQueries, type ChangeEvent } from '@sdlc-on-fire/core';

/**
 * The query shape of the storage port.
 *
 * Rows come back directly rather than wrapped in `{ rows }` — that is what
 * `ProvisionedDatabase` returns, and matching it here keeps the daemon from
 * needing an adapter for its own database handle.
 */
export interface QueryCapable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface CatchUpResult {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
}

export interface CatchUpOptions {
  readonly db: QueryCapable;
  /** ISO timestamp of the newest change the client has already seen. */
  readonly since: string;
  readonly limit?: number;
  /** Restrict to these tables. Absent means every watched table. */
  readonly tables?: readonly string[];
}

/**
 * Everything that changed after `since`, per table.
 *
 * Returns rows rather than events, because that is what the client actually
 * needs: it missed the change *and* the state, and a second round trip per
 * missed row would make a long disconnection quadratic.
 */
export async function catchUp(options: CatchUpOptions): Promise<readonly CatchUpResult[]> {
  const queries = catchUpQueries(options.since, options.limit).filter(
    (query) =>
      options.tables === undefined ||
      options.tables.length === 0 ||
      options.tables.includes(query.table),
  );

  const results: CatchUpResult[] = [];
  for (const query of queries) {
    const rows = await options.db.query<Record<string, unknown>>(query.sql, [...query.params]);
    if (rows.length > 0) results.push({ table: query.table, rows });
  }
  return results;
}

/**
 * The newest watermark across a catch-up result, for the client to store.
 *
 * `null` when nothing came back, which the caller must treat as "keep the
 * watermark you had" and not as "start from the beginning" — the latter would
 * make an idle period replay the entire table.
 */
export function newestWatermark(results: readonly CatchUpResult[]): string | null {
  let newest: string | null = null;
  for (const result of results) {
    for (const row of result.rows) {
      const value = row['updated_at'] ?? row['created_at'];
      if (typeof value === 'string' && (newest === null || value > newest)) newest = value;
      else if (value instanceof Date) {
        const iso = value.toISOString();
        if (newest === null || iso > newest) newest = iso;
      }
    }
  }
  return newest;
}

/** Whether an event is newer than a watermark — the de-duplication rule. */
export function isNewerThan(event: ChangeEvent, watermark: string | null): boolean {
  if (watermark === null) return true;
  return event.updated_at > watermark;
}

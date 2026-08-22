/**
 * Persistence for tracker sync cursors (P5-TRACK-01, contract 01 §3.10).
 *
 * These rows are **state, not content**. They never appear in `.sdlc/`, and
 * they deliberately survive `db:rebuild` — see the contract for why: a rebuild
 * that dropped them would unlink every pair, and an unlinked pair whose sides
 * differ is a conflict, so rebuilding would flood the next sync with
 * divergences that the rebuild itself invented.
 */

import type { SyncCursor } from '@sdlc-on-fire/core';

/** The minimal query surface, so this works against PGlite and Postgres alike. */
export interface CursorRunner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface CursorRow {
  ref_key: string;
  remote_id: string;
  local_fingerprint: string;
  remote_updated_at: string;
}

export async function loadCursors(db: CursorRunner): Promise<Map<string, SyncCursor>> {
  const rows = await db.query<CursorRow>(
    'SELECT ref_key, remote_id, local_fingerprint, remote_updated_at FROM tracker_sync_cursors;',
  );
  return new Map(
    rows.map((row) => [
      row.ref_key,
      {
        key: row.ref_key,
        remoteId: row.remote_id,
        localFingerprint: row.local_fingerprint,
        remoteUpdatedAt: row.remote_updated_at,
      },
    ]),
  );
}

/**
 * Write a cursor, replacing any earlier one for the same pair.
 *
 * `ON CONFLICT ... DO UPDATE` rather than delete-then-insert: the second shape
 * has a window in which the pair has no cursor at all, and a run that dies in
 * that window comes back to an unlinked pair — which is a conflict on the next
 * pass, on an item that was never in conflict.
 */
export async function saveCursor(db: CursorRunner, cursor: SyncCursor): Promise<void> {
  await db.query(
    `INSERT INTO tracker_sync_cursors (ref_key, remote_id, local_fingerprint, remote_updated_at, synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (ref_key) DO UPDATE SET
       remote_id         = EXCLUDED.remote_id,
       local_fingerprint = EXCLUDED.local_fingerprint,
       remote_updated_at = EXCLUDED.remote_updated_at,
       synced_at         = now();`,
    [cursor.key, cursor.remoteId, cursor.localFingerprint, cursor.remoteUpdatedAt],
  );
}

export async function saveCursors(db: CursorRunner, cursors: readonly SyncCursor[]): Promise<void> {
  for (const cursor of cursors) await saveCursor(db, cursor);
}

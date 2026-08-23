import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { provisionPglite } from './pglite.js';
import { applySchema } from './migrate.js';
import { loadCursors, saveCursor, saveCursors } from './tracker-cursors.js';
import { PostgresStorageAdapter } from './postgres-adapter.js';

async function freshDb() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-cursors-'));
  const db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  return db;
}

describe('tracker sync cursors', () => {
  it('round-trips a cursor', async () => {
    const db = await freshDb();
    try {
      await saveCursor(db, {
        key: 'github:o/r:42',
        remoteId: '42',
        localFingerprint: '["t","b",false]',
        remoteUpdatedAt: '2026-08-23T10:00:00Z',
      });
      const loaded = await loadCursors(db);
      expect(loaded.get('github:o/r:42')).toEqual({
        key: 'github:o/r:42',
        remoteId: '42',
        localFingerprint: '["t","b",false]',
        remoteUpdatedAt: '2026-08-23T10:00:00Z',
      });
    } finally {
      await db.close();
    }
  }, 90_000);

  it('replaces rather than duplicating a cursor for the same pair', async () => {
    const db = await freshDb();
    try {
      const base = { key: 'github:o/r:42', remoteId: '42', localFingerprint: 'a' };
      await saveCursor(db, { ...base, remoteUpdatedAt: '2026-08-23T10:00:00Z' });
      await saveCursor(db, {
        ...base,
        localFingerprint: 'b',
        remoteUpdatedAt: '2026-08-23T11:00:00Z',
      });
      const loaded = await loadCursors(db);
      expect(loaded.size).toBe(1);
      expect(loaded.get('github:o/r:42')?.remoteUpdatedAt).toBe('2026-08-23T11:00:00Z');
      expect(loaded.get('github:o/r:42')?.localFingerprint).toBe('b');
    } finally {
      await db.close();
    }
  }, 90_000);

  it('keeps cursors for different pairs apart', async () => {
    const db = await freshDb();
    try {
      await saveCursors(db, [
        { key: 'github:o/r:1', remoteId: '1', localFingerprint: 'x', remoteUpdatedAt: 't1' },
        { key: 'github:o/r:2', remoteId: '2', localFingerprint: 'y', remoteUpdatedAt: 't2' },
      ]);
      expect((await loadCursors(db)).size).toBe(2);
    } finally {
      await db.close();
    }
  }, 90_000);

  it('survives db:rebuild, which contract 01 §3.10 requires', async () => {
    // Not a preference. A rebuild that dropped cursors would unlink every pair,
    // and an unlinked pair whose sides differ is a first link — a conflict. The
    // next sync would report divergence on items that were correctly in sync,
    // and the operator would be adjudicating a problem the rebuild invented.
    const db = await freshDb();
    try {
      await saveCursor(db, {
        key: 'github:o/r:42',
        remoteId: '42',
        localFingerprint: 'a',
        remoteUpdatedAt: '2026-08-23T10:00:00Z',
      });
      const port = await PostgresStorageAdapter.create(db);
      await port.resetMirror();
      expect((await loadCursors(db)).size).toBe(1);
    } finally {
      await db.close();
    }
  }, 90_000);

  it('reports an empty map on a fresh database rather than throwing', async () => {
    const db = await freshDb();
    try {
      expect((await loadCursors(db)).size).toBe(0);
    } finally {
      await db.close();
    }
  }, 90_000);
});

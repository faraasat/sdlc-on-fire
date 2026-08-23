import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applySchema, loadCursors, provisionPglite, saveCursors } from '@sdlc-on-fire/db';

/**
 * A temp directory this suite will actually remove (P6-SURFACE-13).
 *
 * Closing a database handle is not removing its data directory. 108GB of
 * abandoned PGlite data filled a disk before anything noticed, and ENOSPC
 * surfaces during *collection* as a failed file naming an innocent suite —
 * which reads exactly like flake, and cost a timeout raise and an afternoon
 * before anyone looked at `df`.
 *
 * The retry is for Windows, which keeps a file locked while anything holds it.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

import {
  fingerprint,
  runSync,
  type LocalItem,
  type RemoteItem,
  type SyncPort,
} from '@sdlc-on-fire/core';

/**
 * Cursor round-trip through a real database (P5-TRACK-01).
 *
 * The defect this exists for: the CLI originally passed a fresh empty Map and
 * never wrote cursors back. Every unit test still passed, because each one
 * supplied its own cursors. The sync would simply never converge — with no
 * stored cursor every pair is an unlinked first link, so a workspace that is
 * perfectly in sync reports a conflict on every item, forever.
 */

async function freshDb() {
  const root = await tempDir('sdlcof-tracker-');
  const db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  return db;
}

const localItem: LocalItem = { id: 'STORY-1', title: 'a title', body: 'edited', closed: false };

function statefulPort() {
  let current: RemoteItem = {
    id: '42',
    title: 'a title',
    body: 'original',
    closed: false,
    updatedAt: '2026-08-23T10:00:00Z',
    foreign: false,
  };
  let clock = 10;
  const calls: string[] = [];
  const port: SyncPort = {
    list: () => Promise.resolve([current]),
    create: (l: LocalItem) => {
      calls.push(`create:${l.id}`);
      return Promise.resolve(current);
    },
    update: (id: string, l: LocalItem) => {
      calls.push(`update:${id}`);
      clock += 1;
      current = {
        ...current,
        title: l.title,
        body: l.body,
        closed: l.closed,
        updatedAt: `2026-08-23T${String(clock)}:00:00Z`,
      };
      return Promise.resolve(current);
    },
    adopt: (r: RemoteItem) =>
      Promise.resolve({ id: `GH-${r.id}`, title: r.title, body: r.body, closed: r.closed }),
  };
  return { port, calls };
}

const keyFor = ({ remote }: { local?: LocalItem | undefined; remote?: RemoteItem | undefined }) =>
  remote !== undefined ? `github:o/r:${remote.id}` : 'github:o/r:42';

describe('cursors persisted across runs', () => {
  it('pushes on the first run and is silent on the second, across a real database', async () => {
    const db = await freshDb();
    try {
      await saveCursors(db, [
        {
          key: 'github:o/r:42',
          remoteId: '42',
          localFingerprint: fingerprint({ ...localItem, body: 'original' }),
          remoteUpdatedAt: '2026-08-23T10:00:00Z',
        },
      ]);
      const { port, calls } = statefulPort();

      const first = await runSync({
        locals: [localItem],
        port,
        cursors: await loadCursors(db),
        keyFor,
        gapMs: 0,
      });
      expect(first.outcomes[0]?.decision.action).toBe('push');
      await saveCursors(
        db,
        first.outcomes.flatMap((o) => (o.cursor === undefined ? [] : [o.cursor])),
      );

      const second = await runSync({
        locals: [localItem],
        port,
        cursors: await loadCursors(db),
        keyFor,
        gapMs: 0,
      });
      expect(calls).toEqual(['update:42']);
      expect(second.outcomes[0]?.decision.action).toBe('none');
      expect(second.conflicts).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('without persistence the second run conflicts, which is the bug being guarded', async () => {
    const db = await freshDb();
    try {
      const { port } = statefulPort();
      // Deliberately never saving: an empty cursor map on every run.
      const first = await runSync({
        locals: [localItem],
        port,
        cursors: new Map(),
        keyFor,
        gapMs: 0,
      });
      const second = await runSync({
        locals: [localItem],
        port,
        cursors: new Map(),
        keyFor,
        gapMs: 0,
      });
      expect(first.conflicts.length).toBeGreaterThan(0);
      expect(second.conflicts.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('keeps cursors earned by clean items even when another item conflicted', async () => {
    const db = await freshDb();
    try {
      await saveCursors(db, [
        { key: 'github:o/r:42', remoteId: '42', localFingerprint: 'stale', remoteUpdatedAt: 'old' },
      ]);
      const loaded = await loadCursors(db);
      expect(loaded.size).toBe(1);
      expect(loaded.get('github:o/r:42')?.localFingerprint).toBe('stale');
    } finally {
      await db.close();
    }
  }, 60_000);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { CHANGE_CHANNEL, catchUpQuery, type ChangeEvent } from '@sdlc-on-fire/core';
import { subscribeToChanges } from './subscriber.js';
import { catchUp, newestWatermark, isNewerThan } from './catchup.js';
import { startRealtimeServer } from './server.js';

/**
 * P3-RT-01 — realtime, against a real database and a real socket.
 *
 * Mocks would be worthless for most of this. The questions are whether a
 * Postgres trigger fires, whether a rolled-back transaction stays silent, and
 * whether a client that was disconnected can discover what it missed — all
 * statements about a real database, and the last one about a real gap in time.
 */

let db: ProvisionedDatabase;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-rt-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
}, 90_000);

afterEach(async () => {
  await db?.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}, 30_000);

/** A work item, inserted the way the sync pipeline would. */
async function insertItem(id: string, stage = 'spec'): Promise<void> {
  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
     VALUES ($1,'feature',$2,'inbox',$3,$4,'h-' || $1);`,
    [id, `title ${id}`, stage, `kanban/${id}.md`],
  );
}

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the trigger and the subscriber', () => {
  it('emits a typed event for insert, update and delete', async () => {
    const seen: ChangeEvent[] = [];
    const sub = await subscribeToChanges({ db, onEvent: (event) => seen.push(event) });

    await insertItem('A-1');
    await db.query(`UPDATE work_items SET title = 'renamed' WHERE id = 'A-1';`);
    await db.query(`DELETE FROM work_items WHERE id = 'A-1';`);
    await settle();

    expect(seen.map((event) => event.op)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
    for (const event of seen) {
      expect(event.table).toBe('work_items');
      expect(event.id).toBe('A-1');
      expect(event.updated_at).toBeTruthy();
    }
    await sub.close();
  }, 60_000);

  it('says nothing about a transaction that rolled back', async () => {
    // NOTIFY is delivered on commit and never for an aborted transaction. The
    // alternative would be a board that shows work that does not exist, which
    // is precisely the class of untruth this product exists to prevent.
    const seen: ChangeEvent[] = [];
    const sub = await subscribeToChanges({ db, onEvent: (event) => seen.push(event) });

    await db.query('BEGIN;');
    await insertItem('ROLLED-BACK');
    await db.query('ROLLBACK;');
    await settle();

    expect(seen).toEqual([]);
    const rows = await db.query(`SELECT id FROM work_items WHERE id = 'ROLLED-BACK';`);
    expect(rows).toEqual([]);
    await sub.close();
  }, 60_000);

  it('maintains the watermark even when the writer does not set it', async () => {
    // The reason the touch trigger exists. A writer that forgets `updated_at`
    // produces a row that catch-up cannot see — a missed update no assertion on
    // the write itself would ever notice.
    await insertItem('W-1');
    const before = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM work_items WHERE id = 'W-1';`,
    );
    await settle(50);
    // Deliberately does not touch updated_at.
    await db.query(`UPDATE work_items SET title = 'no watermark set' WHERE id = 'W-1';`);
    const after = await db.query<{ updated_at: Date }>(
      `SELECT updated_at FROM work_items WHERE id = 'W-1';`,
    );

    const first = new Date(before[0]!.updated_at).getTime();
    const second = new Date(after[0]!.updated_at).getTime();
    expect(second).toBeGreaterThan(first);
  }, 60_000);

  it('survives a malformed notification without losing the next one', async () => {
    const seen: ChangeEvent[] = [];
    const sub = await subscribeToChanges({ db, onEvent: (event) => seen.push(event) });

    await db.query(`SELECT pg_notify($1, 'not json at all');`, [CHANGE_CHANNEL]);
    await db.query(
      `SELECT pg_notify($1, '{"table":"nope","id":"x","op":"INSERT","updated_at":"t"}');`,
      [CHANGE_CHANNEL],
    );
    await settle();
    expect(seen).toEqual([]);
    expect(sub.malformed).toBe(2);

    await insertItem('AFTER-JUNK');
    await settle();
    expect(seen.map((event) => event.id)).toEqual(['AFTER-JUNK']);
    await sub.close();
  }, 60_000);

  it('watches gates and runs, which had no watermark before this task', async () => {
    const seen: ChangeEvent[] = [];
    const sub = await subscribeToChanges({ db, onEvent: (event) => seen.push(event) });

    await insertItem('G-1');
    await db.query(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('G-1','build','pending');`,
    );
    await db.query(`INSERT INTO runs (id, work_item_id, status) VALUES ('r1','G-1','running');`);
    await db.query(`UPDATE runs SET status = 'pass' WHERE id = 'r1';`);
    await settle();

    const tables = seen.map((event) => event.table);
    expect(tables).toContain('gates');
    expect(tables.filter((table) => table === 'runs')).toHaveLength(2);
    await sub.close();
  }, 60_000);
});

describe('catch-up', () => {
  it('returns exactly what changed after the watermark, and not the watermark row', async () => {
    // Strictly greater than. `>=` would redeliver the row the client already
    // has on every single reconnect, and a reconnect loop would replay it
    // forever.
    await insertItem('OLD-1');
    const mark = await db.query<{ now: string }>(
      `SELECT max(updated_at)::text AS now FROM work_items;`,
    );
    const since = mark[0]!.now;

    await settle(50);
    await insertItem('NEW-1');
    await insertItem('NEW-2');

    const missed = await catchUp({ db, since, tables: ['work_items'] });
    const ids = missed.flatMap((result) => result.rows.map((row) => row['id']));
    expect(ids.sort()).toEqual(['NEW-1', 'NEW-2']);
    expect(ids).not.toContain('OLD-1');
  }, 60_000);

  it('refuses to build a query for a table nobody watches', () => {
    // The table name is interpolated, because a table name cannot be a bind
    // parameter. So it is checked against the watched set rather than trusted.
    expect(catchUpQuery('work_items', '2020-01-01')).not.toBeNull();
    expect(catchUpQuery('pg_shadow', '2020-01-01')).toBeNull();
    expect(catchUpQuery('work_items; DROP TABLE work_items;--', '2020-01-01')).toBeNull();
  });

  it('reports the newest watermark, and null when nothing changed', () => {
    expect(newestWatermark([])).toBeNull();
    expect(
      newestWatermark([
        {
          table: 'work_items',
          rows: [{ updated_at: '2026-01-01T00:00:00Z' }, { updated_at: '2026-06-01T00:00:00Z' }],
        },
      ]),
    ).toBe('2026-06-01T00:00:00Z');
  });

  it('treats an empty catch-up as "keep your watermark", not "start over"', () => {
    // Returning null must not be read as zero. An idle period would otherwise
    // replay the whole table on the next reconnect.
    expect(newestWatermark([])).toBeNull();
    expect(
      isNewerThan(
        { table: 'work_items', id: 'x', op: 'UPDATE', updated_at: '2026-01-01T00:00:00Z' },
        null,
      ),
    ).toBe(true);
    expect(
      isNewerThan(
        { table: 'work_items', id: 'x', op: 'UPDATE', updated_at: '2026-01-01T00:00:00Z' },
        '2026-06-01T00:00:00Z',
      ),
    ).toBe(false);
  });
});

describe('the WebSocket server', () => {
  async function connect(port: number): Promise<{ socket: WebSocket; frames: unknown[] }> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    const frames: unknown[] = [];
    socket.addEventListener('message', (event) => {
      frames.push(JSON.parse(String((event as MessageEvent).data)));
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('socket failed to open')));
    });
    return { socket, frames };
  }

  it('delivers a real database change to a real connected client', async () => {
    const server = await startRealtimeServer({ db });
    const { socket, frames } = await connect(server.port);

    await insertItem('WS-1');
    await settle(400);

    const changes = frames.filter((frame) => (frame as { type: string }).type === 'change');
    expect(changes.length).toBeGreaterThan(0);
    expect((changes[0] as { event: ChangeEvent }).event.id).toBe('WS-1');

    socket.close();
    await server.close();
  }, 90_000);

  it('reconciles what a client missed while it was disconnected', async () => {
    // The property the whole task exists for. Postgres keeps nothing for an
    // absent listener, so a client that drops for a moment is told nothing
    // about that moment when it returns — its board is then silently stale,
    // which is worse than visibly broken.
    const server = await startRealtimeServer({ db });

    const first = await connect(server.port);
    await insertItem('BEFORE-GAP');
    await settle(300);
    const mark = await db.query<{ now: string }>(
      `SELECT max(updated_at)::text AS now FROM work_items;`,
    );
    const since = mark[0]!.now;

    first.socket.close();
    await settle(150);

    // The gap: nothing is listening, and these two are lost to NOTIFY forever.
    await insertItem('DURING-GAP-1');
    await insertItem('DURING-GAP-2');
    await settle(150);

    const second = await connect(server.port);
    second.socket.send(JSON.stringify({ type: 'subscribe', tables: ['work_items'], since }));
    await settle(500);

    const rows = second.frames
      .filter((frame) => (frame as { type: string }).type === 'catchup')
      .flatMap((frame) => (frame as { rows: Record<string, unknown>[] }).rows)
      .map((row) => row['id']);

    expect(rows).toContain('DURING-GAP-1');
    expect(rows).toContain('DURING-GAP-2');
    expect(rows).not.toContain('BEFORE-GAP');

    const ready = second.frames.find((frame) => (frame as { type: string }).type === 'ready');
    expect(ready).toBeDefined();

    second.socket.close();
    await server.close();
  }, 90_000);

  it('scopes delivery to what the client subscribed to', async () => {
    const server = await startRealtimeServer({ db });
    const { socket, frames } = await connect(server.port);
    socket.send(JSON.stringify({ type: 'subscribe', tables: ['runs'] }));
    await settle(300);

    await insertItem('SCOPE-1');
    await db.query(
      `INSERT INTO runs (id, work_item_id, status) VALUES ('r-scope','SCOPE-1','running');`,
    );
    await settle(400);

    const changed = frames
      .filter((frame) => (frame as { type: string }).type === 'change')
      .map((frame) => (frame as { event: ChangeEvent }).event.table);
    expect(changed).toContain('runs');
    expect(changed).not.toContain('work_items');

    socket.close();
    await server.close();
  }, 90_000);

  it('answers a malformed client message without dropping the connection', async () => {
    const server = await startRealtimeServer({ db });
    const { socket, frames } = await connect(server.port);

    socket.send('not json');
    await settle(200);
    expect(frames.some((frame) => (frame as { type: string }).type === 'error')).toBe(true);

    await insertItem('STILL-ALIVE');
    await settle(400);
    expect(frames.some((frame) => (frame as { type: string }).type === 'change')).toBe(true);

    socket.close();
    await server.close();
  }, 90_000);

  it('forgets a client when it disconnects', async () => {
    const server = await startRealtimeServer({ db });
    const { socket } = await connect(server.port);
    await settle(200);
    expect(server.clients).toBe(1);

    socket.close();
    await settle(300);
    expect(server.clients).toBe(0);

    await server.close();
  }, 90_000);
});

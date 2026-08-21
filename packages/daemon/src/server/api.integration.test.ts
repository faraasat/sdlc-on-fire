import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { startRealtimeServer, type RealtimeServer } from '../realtime/server.js';
import { createApiHandler } from './api.js';

/**
 * P3-UI-01 — the read API, over a real socket against a real database.
 *
 * The guard in particular has to be tested through actual HTTP: what is under
 * test is the handling of a header, and a unit test that calls the predicate
 * directly proves the predicate and not the wiring. The defect worth catching
 * is a correct check that nothing calls.
 */

let db: ProvisionedDatabase;
let root: string;
let server: RealtimeServer;
let base: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-api-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  server = await startRealtimeServer({
    db,
    onRequest: createApiHandler({ db, gitEmail: 'solo@example.com', version: 'test' }),
  });
  base = `http://127.0.0.1:${String(server.port)}`;
}, 90_000);

afterEach(async () => {
  await server?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}, 30_000);

/** A GET with an arbitrary Host header, which `fetch` refuses to send. */
async function rawGet(pathname: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: server.port, path: pathname, method: 'GET', headers: { host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function seedItem(id: string): Promise<void> {
  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
     VALUES ($1,'feature',$2,'inbox','spec',$3,'h-' || $1);`,
    [id, `title ${id}`, `kanban/${id}.md`],
  );
}

describe('the read API', () => {
  it('serves health', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, version: 'test' });
  });

  it('lists work items from the real database', async () => {
    await seedItem('API-1');
    await seedItem('API-2');
    const rows = (await (await fetch(`${base}/api/work-items`)).json()) as { id: string }[];
    expect(rows.map((row) => row.id).sort()).toEqual(['API-1', 'API-2']);
  });

  it('returns a card with everything a card needs, in one request', async () => {
    // Three round trips per card is what makes a board feel slow.
    await seedItem('API-3');
    await db.query(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('API-3','build','pass');`,
    );
    await db.query(`INSERT INTO runs (id, work_item_id, status) VALUES ('r1','API-3','pass');`);

    const body = (await (await fetch(`${base}/api/work-items/API-3`)).json()) as {
      item: { id: string };
      gates: unknown[];
      runs: unknown[];
      comments: unknown[];
    };
    expect(body.item.id).toBe('API-3');
    expect(body.gates).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
    expect(body.comments).toEqual([]);
  });

  it('aggregates gate state so a board does not ask per card', async () => {
    // 200 cards each fetching their own gates is 200 requests. Worst result
    // wins: one failing gate blocks the card whatever the others say.
    await seedItem('AGG-1');
    await db.query(
      `INSERT INTO gates (work_item_id, gate_name, result)
       VALUES ('AGG-1','build','pass'), ('AGG-1','test','fail');`,
    );
    await seedItem('AGG-2');
    await db.query(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('AGG-2','build','pass');`,
    );
    await seedItem('AGG-3');

    const rows = (await (await fetch(`${base}/api/work-items`)).json()) as {
      id: string;
      gate_state: string | null;
      active_run: string | null;
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('AGG-1')?.gate_state).toBe('fail');
    expect(byId.get('AGG-2')?.gate_state).toBe('pass');
    // No gates at all is null, not 'pass'. A card nothing has checked has not
    // passed anything, which is the distinction this whole product is about.
    expect(byId.get('AGG-3')?.gate_state).toBeNull();
  });

  it('reports a running agent, and only a running one', async () => {
    await seedItem('RUN-1');
    await db.query(
      `INSERT INTO runs (id, work_item_id, status) VALUES ('done-run','RUN-1','pass');`,
    );
    let rows = (await (await fetch(`${base}/api/work-items`)).json()) as {
      id: string;
      active_run: string | null;
    }[];
    expect(rows.find((row) => row.id === 'RUN-1')?.active_run).toBeNull();

    await db.query(
      `INSERT INTO runs (id, work_item_id, status) VALUES ('live-run','RUN-1','running');`,
    );
    rows = (await (await fetch(`${base}/api/work-items`)).json()) as {
      id: string;
      active_run: string | null;
    }[];
    expect(rows.find((row) => row.id === 'RUN-1')?.active_run).toBe('live-run');
  });

  it('404s a work item that does not exist, rather than an empty card', async () => {
    const response = await fetch(`${base}/api/work-items/NOPE`);
    expect(response.status).toBe(404);
  });

  it('resolves solo-mode identity without marking it attributable', async () => {
    await db.query(
      `INSERT INTO actors (kind, display_name, email) VALUES ('human','Solo','other@example.com');`,
    );
    const identity = (await (await fetch(`${base}/api/identity`)).json()) as {
      ground: string;
      attributable: boolean;
      actor: { displayName: string } | null;
    };
    expect(identity.ground).toBe('solo-implicit');
    expect(identity.attributable).toBe(false);
    expect(identity.actor?.displayName).toBe('Solo');
  });

  it('resolves by git email when one matches', async () => {
    await db.query(
      `INSERT INTO actors (kind, display_name, email) VALUES ('human','Solo','solo@example.com'),
                                                             ('human','Other','other@example.com');`,
    );
    const identity = (await (await fetch(`${base}/api/identity`)).json()) as {
      ground: string;
      attributable: boolean;
    };
    expect(identity.ground).toBe('git-email');
    expect(identity.attributable).toBe(true);
  });

  it('refuses a request whose Host is not loopback', async () => {
    // The DNS-rebinding case, through real HTTP. The rebinding page reaches
    // 127.0.0.1 but the browser still sends the attacker's own Host, and this
    // is the line that actually holds — binding to loopback does not.
    //
    // Sent with `node:http` rather than `fetch`, because `Host` is a forbidden
    // header name: fetch drops it silently and sends the real one. The first
    // version of this test did exactly that, got 200, and would have reported
    // the guard as broken when it was the test that could not reach it.
    const attacker = await rawGet('/api/work-items', 'evil.com');
    expect(attacker.status).toBe(403);
    expect(JSON.parse(attacker.body)).toMatchObject({ error: 'host not allowed' });

    // And the same request with a loopback Host is served, so the 403 above is
    // the header being refused rather than the route being broken.
    const ok = await rawGet('/api/work-items', '127.0.0.1');
    expect(ok.status).toBe(200);
  });

  it('refuses a cross-origin GET from a remote page', async () => {
    const response = await fetch(`${base}/api/work-items`, {
      headers: { origin: 'https://evil.com' },
    });
    expect(response.status).toBe(403);
  });

  it('allows a loopback origin, because the dev server has its own port', async () => {
    const response = await fetch(`${base}/api/work-items`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('never answers with a wildcard origin', async () => {
    // `*` would let every page on the internet read the board.
    const response = await fetch(`${base}/api/work-items`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('is read-only', async () => {
    // Writes go through the same paths the CLI and agents use, so there is
    // never a second implementation of what happened (ADR-0016).
    const response = await fetch(`${base}/api/work-items`, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('does not cache, because a cached board is a wrong board', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('reports an unknown API route as 404 rather than hanging', async () => {
    expect((await fetch(`${base}/api/nonsense`)).status).toBe(404);
  });

  it('leaves non-API paths to the rest of the server', async () => {
    expect((await fetch(`${base}/not-api`)).status).toBe(404);
  });
});

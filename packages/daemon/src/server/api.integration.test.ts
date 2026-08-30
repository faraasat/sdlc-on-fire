import fs from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  seedLifecycleStates,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
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
  // `lifecycle_transitions.to_state` is a foreign key into `lifecycle_states`,
  // so a transition cannot be seeded until the state vocabulary exists.
  await seedLifecycleStates(db);
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

/**
 * P4-COLLAB-01 — the activity feed, over a real database.
 *
 * This is the only test that can catch the defect the endpoint is most likely
 * to have. Its four queries name columns across two tables defined in raw SQL
 * and two defined in Drizzle, and a wrong-but-plausible column name typechecks
 * perfectly — `lifecycle_transitions.actor` and `comments.author` both read as
 * obviously right and neither exists. Nothing but execution against a real
 * schema distinguishes them.
 */
describe('the activity feed', () => {
  it('builds a feed from every source, newest first', async () => {
    await seedItem('FEED-1');
    await db.query(
      `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state)
       VALUES ('FEED-1', 'spec', 'implement');`,
    );
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('FEED-1', 'blocker', 'the gate is wrong', 'GATE_BLOCK');`,
    );

    const response = await fetch(`${base}/api/activity`);
    expect(response.status).toBe(200);
    const feed = (await response.json()) as { kind: string; cardId: string; severity: string }[];

    expect(feed.map((entry) => entry.kind).sort()).toEqual(['comment', 'transition']);
    expect(feed.every((entry) => entry.cardId === 'FEED-1')).toBe(true);
  });

  it('carries the stored role_effect rather than re-deriving it', async () => {
    // ADR-0012: the effect was resolved from (type × role) at insert. The feed
    // reads that column; it does not compute a second opinion.
    await seedItem('FEED-2');
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('FEED-2', 'normal', 'looks fine to me', 'GATE_BLOCK');`,
    );

    const feed = (await (await fetch(`${base}/api/activity`)).json()) as {
      kind: string;
      effect?: string;
      severity: string;
    }[];
    const comment = feed.find((entry) => entry.kind === 'comment');

    // The type says `normal`. The stored effect says GATE_BLOCK. A feed that
    // re-derived from the type would call this quiet and hide a blocked gate.
    expect(comment?.effect).toBe('GATE_BLOCK');
    expect(comment?.severity).toBe('blocking');
  });

  it('names the actor behind a transition instead of a uuid', async () => {
    await seedItem('FEED-3');
    const actor = (
      await db.query<{ id: string }>(
        `INSERT INTO actors (kind, display_name) VALUES ('human', 'Ana Ruiz') RETURNING id;`,
      )
    )[0];
    await db.query(
      `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state, actor_id)
       VALUES ('FEED-3', 'spec', 'implement', $1);`,
      [actor?.id],
    );

    const feed = (await (await fetch(`${base}/api/activity`)).json()) as {
      kind: string;
      actor: string | null;
    }[];
    expect(feed.find((entry) => entry.kind === 'transition')?.actor).toBe('Ana Ruiz');
  });

  it('keeps an unattributed event rather than dropping it', async () => {
    // LEFT JOIN, not INNER. An inner join silently removes every event nobody
    // signed for — the feed would look clean and be incomplete.
    await seedItem('FEED-4');
    await db.query(
      `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state)
       VALUES ('FEED-4', 'spec', 'implement');`,
    );

    const feed = (await (await fetch(`${base}/api/activity`)).json()) as {
      cardId: string;
      actor: string | null;
    }[];
    const entry = feed.find((row) => row.cardId === 'FEED-4');
    expect(entry).toBeDefined();
    expect(entry?.actor).toBeNull();
  });

  it('scopes to one card when asked', async () => {
    await seedItem('FEED-5');
    await seedItem('FEED-6');
    for (const id of ['FEED-5', 'FEED-6']) {
      await db.query(
        `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state)
         VALUES ($1, 'spec', 'implement');`,
        [id],
      );
    }

    const feed = (await (await fetch(`${base}/api/activity?workItemId=FEED-5`)).json()) as {
      cardId: string;
    }[];
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((entry) => entry.cardId === 'FEED-5')).toBe(true);
  });

  it('bounds the limit rather than trusting the query string', async () => {
    await seedItem('FEED-7');
    const bad = await fetch(`${base}/api/activity?limit=not-a-number`);
    expect(bad.status).toBe(200);
    const huge = await fetch(`${base}/api/activity?limit=999999`);
    expect(huge.status).toBe(200);
  });
});

/**
 * P4-COLLAB-03 — saved views over HTTP.
 *
 * The reader is tested in the CLI package against a real directory. What only
 * this shows is the injection seam: a server started without a views provider
 * must serve an empty list rather than failing, because a board with no view
 * picker still works and a 500 here would take the whole board down with it.
 */
/**
 * P6-SURFACE-04 — the timeline and doc endpoints over a real database.
 *
 * The projections are pure and tested in core. What only this can show is the
 * wiring: that the timeline joins to `actors` for a name, and that the insertion
 * reader's absence is *reported* rather than served as an empty list — a missing
 * reader and a clean card look identical otherwise.
 */
describe('the timeline endpoint', () => {
  it('refuses without a work item rather than serving every card', async () => {
    const response = await fetch(`${base}/api/timeline`);
    expect(response.status).toBe(400);
  });

  it('says a card has not moved rather than returning nothing', async () => {
    await seedItem('TASK-900');
    const body = (await (await fetch(`${base}/api/timeline?workItemId=TASK-900`)).json()) as {
      entries: unknown[];
      because: string;
    };
    expect(body.entries).toEqual([]);
    expect(body.because).toContain('has not moved');
  });

  it('reports that nobody looked for insertions, rather than that there were none', async () => {
    await seedItem('TASK-901');
    const body = (await (await fetch(`${base}/api/timeline?workItemId=TASK-901`)).json()) as {
      insertionsAvailable: boolean;
    };
    // This server was started without an insertion reader.
    expect(body.insertionsAvailable).toBe(false);
  });
});

describe('the docs endpoint', () => {
  it('projects the same rows two ways', async () => {
    await db.query(
      `INSERT INTO docs (id, doc_type, file_path, content_hash, title, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb), ($7,$8,$9,$10,$11,$12::jsonb);`,
      [
        'ADR-0001',
        'decision',
        'docs/ADR-0001.md',
        'a'.repeat(64),
        'A decision',
        JSON.stringify({ adr_id: 'ADR-0001', status: 'accepted' }),
        'R-1',
        'research',
        'docs/R-1.md',
        'b'.repeat(64),
        'A note',
        JSON.stringify({ topic: 'retrieval' }),
      ],
    );

    const body = (await (await fetch(`${base}/api/docs`)).json()) as {
      docs: unknown[];
      research: { total: number; unlinked: string[] };
      decisions: { entries: unknown[] };
    };
    expect(body.docs).toHaveLength(2);
    expect(body.research.total).toBe(1);
    // The note is linked to nothing, which is the number the panel leads with.
    expect(body.research.unlinked).toEqual(['R-1']);
    expect(body.decisions.entries).toHaveLength(1);
  });

  it('filters by doc type', async () => {
    await db.query(
      `INSERT INTO docs (id, doc_type, file_path, content_hash, title, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb);`,
      ['R-2', 'research', 'docs/R-2.md', 'c'.repeat(64), 'Another', JSON.stringify({})],
    );
    const body = (await (await fetch(`${base}/api/docs?docType=decision`)).json()) as {
      docs: unknown[];
    };
    expect(body.docs).toEqual([]);
  });
});

describe('the views endpoint', () => {
  it('serves an empty list when the server has no views provider', async () => {
    const response = await fetch(`${base}/api/views`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('refuses an unknown role rather than returning everything', async () => {
    const response = await fetch(`${base}/api/views?role=devops`);
    expect(response.status).toBe(400);
  });

  it('accepts a known role', async () => {
    const response = await fetch(`${base}/api/views?role=security`);
    expect(response.status).toBe(200);
  });
});

/**
 * P4-COLLAB-02 — notifications over a real database.
 *
 * The parsing and fan-out are pure and tested in core. What only this can show
 * is the roster query: that a role mention resolves through `memberships` to
 * real actors, and — the one that matters — that an **expired** membership does
 * not. A lapsed reviewer who still gets paged as one is a defect nobody
 * notices, because the notification looks exactly like a correct one.
 */
describe('the notifications endpoint', () => {
  async function actor(name: string): Promise<string> {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO actors (kind, display_name) VALUES ('human', $1) RETURNING id;`,
      [name],
    );
    return rows[0]?.id ?? '';
  }

  async function grant(actorId: string, roleKey: string, expiresAt: string | null): Promise<void> {
    await db.query(
      `INSERT INTO memberships (actor_id, role_id, expires_at)
       SELECT $1, r.id, $3::timestamptz FROM roles r WHERE r.key = $2;`,
      [actorId, roleKey, expiresAt],
    );
  }

  it('resolves a role mention to the actors holding it', async () => {
    await seedItem('NOTE-1');
    const ana = await actor('ana');
    await grant(ana, 'security', null);
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('NOTE-1', 'normal', 'please review @security', 'NONE');`,
    );

    const feed = (await (await fetch(`${base}/api/notifications`)).json()) as {
      actorId: string;
      because: string;
      tier: string;
    }[];
    expect(feed.map((n) => n.actorId)).toEqual([ana]);
    expect(feed[0]?.because).toBe('@security (role)');
  });

  it('does not page someone whose membership has expired', async () => {
    // The defect that looks identical to correct behaviour from the outside.
    await seedItem('NOTE-2');
    const bo = await actor('bo');
    await grant(bo, 'qa', '2020-01-01T00:00:00Z');
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('NOTE-2', 'normal', 'over to @qa', 'NONE');`,
    );

    const feed = (await (await fetch(`${base}/api/notifications`)).json()) as { actorId: string }[];
    expect(feed).toEqual([]);
  });

  it('makes a blocking effect instant even without a mention of urgency', async () => {
    await seedItem('NOTE-3');
    const cy = await actor('cy');
    await grant(cy, 'eng-lead', null);
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('NOTE-3', 'normal', '@eng-lead the gate is wrong', 'GATE_BLOCK');`,
    );

    const feed = (await (await fetch(`${base}/api/notifications`)).json()) as { tier: string }[];
    expect(feed[0]?.tier).toBe('instant');
  });

  it('filters to one actor when asked', async () => {
    await seedItem('NOTE-4');
    const ana = await actor('ana2');
    const bo = await actor('bo2');
    await grant(ana, 'security', null);
    await grant(bo, 'qa', null);
    await db.query(
      `INSERT INTO comments (work_item_id, type, body, role_effect)
       VALUES ('NOTE-4', 'normal', '@security and @qa both', 'NONE');`,
    );

    const all = (await (await fetch(`${base}/api/notifications`)).json()) as { actorId: string }[];
    expect(all).toHaveLength(2);
    const mine = (await (
      await fetch(`${base}/api/notifications?actorId=${encodeURIComponent(ana)}`)
    ).json()) as { actorId: string }[];
    expect(mine.map((n) => n.actorId)).toEqual([ana]);
  });

  it('returns nothing rather than failing when there are no comments', async () => {
    expect(await (await fetch(`${base}/api/notifications`)).json()).toEqual([]);
  });
});

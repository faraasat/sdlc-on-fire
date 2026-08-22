/**
 * The daemon's read API (P3-UI-01).
 *
 * Read-mostly on purpose (ADR-0016): the UI reads through here and writes
 * through the same paths a CLI or an agent uses, so there is never a second
 * implementation of "what happened" that can disagree with the first.
 *
 * Mounted on the same HTTP server the WebSocket upgrades from, so a project is
 * one port rather than two — and one guard rather than two.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveIdentity, type Actor, type ResolvedIdentity } from '@sdlc-on-fire/core';
import { isAllowedOrigin, isLoopbackHost } from './guard.js';
import { moveCard } from './move.js';
import {
  bindEvidence,
  bottleneck,
  buildFeed,
  cycleTime,
  flowEfficiency,
  leadTime,
  rework,
  stageStats,
  visitsByCard,
  fanOut,
  parseMentions,
  viewsForRole,
  wipLimits,
  ROLE_KEYS,
  type CommentEvent,
  type EvidenceRow,
  type GateEvent,
  type GateEvidenceLink,
  type GateRow,
  type RoleEffect,
  type RoleKey,
  type RunEvent,
  type TransitionEvent,
  type ViewDefinition,
  type TransitionRow,
} from '@sdlc-on-fire/core';
import type { LifecycleStage } from '@sdlc-on-fire/core';

export interface ApiQueryCapable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ApiOptions {
  readonly db: ApiQueryCapable;
  /**
   * Performs a lifecycle transition. Injected rather than constructed here, so
   * the API cannot become a second transition path — whatever `sdlc advance`
   * drives is what a board drag drives, guards and all.
   */
  readonly transition?: ((id: string, to: LifecycleStage) => Promise<void>) | undefined;
  /**
   * Reads the saved views from `docs/views/` (P4-COLLAB-03).
   *
   * Injected for the same reason `transition` is, plus a layering one: the
   * reader lives in the CLI package and the daemon cannot import it without
   * inverting the dependency. A server started without it serves an empty list
   * rather than failing — a board with no view picker still works.
   */
  readonly views?:
    (() => Promise<{ views: readonly ViewDefinition[]; problems: readonly unknown[] }>) | undefined;
  /** `git config user.email`, resolved once by the caller. */
  readonly gitEmail?: string | undefined;
  readonly version?: string;
}

interface Handled {
  readonly status: number;
  readonly body: unknown;
}

function json(response: ServerResponse, status: number, body: unknown, origin?: string): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    // The API is state, not content. A cached board is a wrong board.
    'cache-control': 'no-store',
    // Defence in depth against the daemon being framed by a hostile page.
    'x-content-type-options': 'nosniff',
  };
  if (origin !== undefined) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

/** Reads and parses a JSON body, capped so a large POST cannot exhaust memory. */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

async function route(url: URL, options: ApiOptions): Promise<Handled | null> {
  const { db } = options;
  const path = url.pathname;

  if (path === '/api/health') {
    return { status: 200, body: { ok: true, version: options.version ?? 'dev' } };
  }

  if (path === '/api/identity') {
    // Mapped to the domain shape here rather than selected `AS "displayName"`,
    // so the SQL stays readable and the boundary between row and domain object
    // is in one visible place.
    const rows = await db.query<{
      id: string;
      kind: 'human' | 'agent';
      display_name: string;
      email: string | null;
    }>(`SELECT id::text AS id, kind, display_name, email FROM actors ORDER BY created_at ASC;`);
    const actors: Actor[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      email: row.email,
    }));
    const identity: ResolvedIdentity = resolveIdentity({
      gitEmail: options.gitEmail,
      actors,
    });
    return { status: 200, body: identity };
  }

  if (path === '/api/work-items') {
    // `gate_state` and `active_run` are aggregated here rather than fetched per
    // card. A board of 200 cards asking for its own gates is 200 requests, and
    // the derived values are two joins the database does far better than the
    // browser does. Worst-result-wins on gates: any fail is a fail, else any
    // pending is pending — a card with one failing gate is blocked whatever the
    // others say.
    const rows = await db.query(
      `SELECT w.id, w.type, w.title, w.status, w.lifecycle_state, w.work_type, w.preset,
              w.risk_level, w.parent_id, w.file_path, w.claimed_by, w.claim_kind,
              w.lease_expires_at, w.created_at, w.updated_at,
              (SELECT CASE
                        WHEN bool_or(g.result = 'fail') THEN 'fail'
                        WHEN bool_or(g.result = 'pending') THEN 'pending'
                        WHEN count(g.id) > 0 THEN 'pass'
                        ELSE NULL
                      END
                 FROM gates g WHERE g.work_item_id = w.id) AS gate_state,
              (SELECT r.id FROM runs r
                WHERE r.work_item_id = w.id AND r.status = 'running'
                ORDER BY r.started_at DESC NULLS LAST LIMIT 1) AS active_run
         FROM work_items w
        ORDER BY w.updated_at DESC LIMIT 1000;`,
    );
    return { status: 200, body: rows };
  }

  const one = /^\/api\/work-items\/([^/]+)$/.exec(path);
  if (one !== null) {
    const id = decodeURIComponent(one[1] ?? '');
    const items = await db.query(`SELECT * FROM work_items WHERE id = $1;`, [id]);
    if (items.length === 0) return { status: 404, body: { error: `no work item ${id}` } };

    // Fetched together because a card is not useful without them, and three
    // round trips per card is what makes a board feel slow.
    const [gates, runs, comments, transitions] = await Promise.all([
      db.query(`SELECT * FROM gates WHERE work_item_id = $1 ORDER BY id ASC;`, [id]),
      db.query(`SELECT * FROM runs WHERE work_item_id = $1 ORDER BY started_at ASC NULLS LAST;`, [
        id,
      ]),
      db.query(`SELECT * FROM comments WHERE work_item_id = $1 ORDER BY created_at ASC;`, [id]),
      db.query(
        `SELECT * FROM lifecycle_transitions WHERE work_item_id = $1 ORDER BY created_at ASC;`,
        [id],
      ),
    ]);
    // Evidence bound to the gate it satisfies (P3-KAN-03). The `gate_evidence`
    // join has existed since Phase 0 and nothing read it — so a gate showed
    // green with no way to see the envelope behind it, which is exactly the
    // shape this product refuses from an agent.
    const [evidenceRows, links] = await Promise.all([
      db.query<EvidenceRow>(
        `SELECT e.id, e.kind, e.producer, e.git_sha, e.confidence::text AS confidence,
                e.produced_at::text AS produced_at, e.expires_at::text AS expires_at
           FROM evidence e
           JOIN gate_evidence ge ON ge.evidence_id = e.id
           JOIN gates g ON g.id = ge.gate_id
          WHERE g.work_item_id = $1;`,
        [id],
      ),
      db.query<GateEvidenceLink>(
        `SELECT ge.gate_id, ge.evidence_id FROM gate_evidence ge
           JOIN gates g ON g.id = ge.gate_id WHERE g.work_item_id = $1;`,
        [id],
      ),
    ]);

    // Narrowed rather than cast-and-stringified: `String()` on a non-string
    // column would produce "[object Object]" and every envelope would then
    // compare unequal to it, reporting the whole card as stale.
    const shaValue = (items[0] as Record<string, unknown>)['git_commit_sha'];
    const headSha = typeof shaValue === 'string' ? shaValue : '';
    const binding = bindEvidence({
      gates: gates as unknown as GateRow[],
      evidence: evidenceRows.map((row) => ({ ...row, confidence: Number(row.confidence) })),
      links,
      headSha,
    });

    return {
      status: 200,
      body: { item: items[0], gates, runs, comments, transitions, binding },
    };
  }

  if (path === '/api/runs') {
    const workItemId = url.searchParams.get('workItemId');
    const rows =
      workItemId === null
        ? await db.query(`SELECT * FROM runs ORDER BY updated_at DESC LIMIT 200;`)
        : await db.query(`SELECT * FROM runs WHERE work_item_id = $1 ORDER BY updated_at DESC;`, [
            workItemId,
          ]);
    return { status: 200, body: rows };
  }

  if (path === '/api/notifications') {
    // Computed from the stored comments, never from a queue. There is no
    // notification table on purpose: a row saying "we told Ana" is state about
    // a delivery, and until a transport exists to do the telling, storing it
    // would be recording an event that never happened. What this answers is
    // "what would reach whom", which is derivable and therefore rebuildable.
    const limitRaw = Number(url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

    const [comments, recipients] = await Promise.all([
      db.query<{
        work_item_id: string;
        body: string;
        role_effect: RoleEffect;
        author_actor_id: string | null;
        created_at: string;
      }>(
        `SELECT work_item_id, body, role_effect, author_actor_id, created_at::text AS created_at
           FROM comments ORDER BY created_at DESC LIMIT ${String(limit)};`,
      ),
      // One query, not one per comment. Memberships are small and the fan-out
      // is pure, so pulling the roster once and resolving in memory avoids a
      // query per comment against a table that will not grow with the backlog.
      db.query<{ actor_id: string; handle: string; role_key: string | null }>(
        `SELECT a.id AS actor_id, a.display_name AS handle, r.key AS role_key
           FROM actors a
           LEFT JOIN memberships m
             ON m.actor_id = a.id
            AND (m.expires_at IS NULL OR m.expires_at > now())
           LEFT JOIN roles r ON r.id = m.role_id;`,
      ),
    ]);

    const roster = new Map<string, { actorId: string; handle: string; roles: RoleKey[] }>();
    for (const row of recipients) {
      const existing = roster.get(row.actor_id) ?? {
        actorId: row.actor_id,
        handle: row.handle,
        roles: [] as RoleKey[],
      };
      // An expired membership arrives as a null role via the LEFT JOIN and must
      // not become a role. Filtering on the join rather than after it is what
      // keeps a lapsed reviewer from still being paged as one.
      if (row.role_key !== null && (ROLE_KEYS as readonly string[]).includes(row.role_key)) {
        existing.roles.push(row.role_key as RoleKey);
      }
      roster.set(row.actor_id, existing);
    }
    const people = [...roster.values()];

    const out = comments.flatMap((comment) =>
      fanOut({
        mentions: parseMentions(comment.body),
        recipients: people,
        effect: comment.role_effect,
        authorActorId: comment.author_actor_id,
      }).map((notification) => ({
        ...notification,
        cardId: comment.work_item_id,
        at: comment.created_at,
      })),
    );

    const actorId = url.searchParams.get('actorId');
    return {
      status: 200,
      body: actorId === null ? out : out.filter((n) => n.actorId === actorId),
    };
  }

  if (path === '/api/views') {
    // Read from disk on every request rather than cached. A view is a file a
    // person edits; a cache would mean saving the file and not seeing it, and
    // the directory is small enough that the read costs nothing worth keeping.
    // The argument is validated before the provider is consulted. Ordering
    // these the other way makes a bad request succeed whenever the server
    // happens to be configured without views — validation that depends on
    // configuration is validation that reports different answers to the same
    // request for reasons the caller cannot see.
    const role = url.searchParams.get('role');
    if (role !== null && !(ROLE_KEYS as readonly string[]).includes(role)) {
      // Refused rather than ignored. Silently returning every view for a
      // misspelled role tells the caller that role sees all of them.
      return { status: 400, body: { error: `unknown role "${role}"` } };
    }
    if (options.views === undefined) return { status: 200, body: [] };
    const loaded = await options.views();
    return {
      status: 200,
      body: role === null ? loaded.views : viewsForRole(loaded.views, role as RoleKey),
    };
  }

  if (path === '/api/activity') {
    // Built on the server, for the same reason the board's projection is: the
    // feed is a claim about what happened, and a claim assembled in the browser
    // cannot be tested without one. `buildFeed` merges then truncates — the
    // client receives a finished feed and renders it.
    //
    // `role_effect` is selected and carried, never recomputed here. It was
    // resolved from (type x role) at insert (ADR-0012); deriving it a second
    // time in a read path would be a second implementation of the one value the
    // comment model exists to make unambiguous.
    const requested = Number(url.searchParams.get('limit') ?? '100');
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 500) : 100;
    const workItemId = url.searchParams.get('workItemId');
    // Built per query rather than shared, because two of the four join and so
    // need the column qualified. The parameter is still bound, never
    // interpolated — `workItemId` arrives from a query string.
    const params = workItemId === null ? [] : [workItemId];
    const where = (column: string): string => (workItemId === null ? '' : `WHERE ${column} = $1`);

    // Each source is over-fetched to `limit` and merged; the cut happens after.
    // Capping each query at a share of the limit would make the feed's contents
    // depend on which table happened to be busy.
    const [transitions, comments, gates, runs] = await Promise.all([
      // Joined to `actors` for a name. The transition and comment tables carry
      // an actor *id*; a feed that rendered the raw uuid would be technically
      // correct and unreadable. LEFT JOIN, because both columns are nullable —
      // an inner join would silently drop every system-authored event, and a
      // feed missing exactly the entries nobody signed for is worse than one
      // showing them unattributed.
      db.query<TransitionEvent>(
        `SELECT t.work_item_id, t.from_state, t.to_state,
                a.display_name AS actor, t.created_at::text AS created_at
           FROM lifecycle_transitions t
           LEFT JOIN actors a ON a.id = t.actor_id
           ${where('t.work_item_id')} ORDER BY t.created_at DESC LIMIT ${String(limit)};`,
        params,
      ),
      db.query<CommentEvent>(
        `SELECT c.work_item_id, c.type, c.role_effect, c.body,
                a.display_name AS author, a.kind AS author_kind,
                c.created_at::text AS created_at
           FROM comments c
           LEFT JOIN actors a ON a.id = c.author_actor_id
           ${where('c.work_item_id')} ORDER BY c.created_at DESC LIMIT ${String(limit)};`,
        params,
      ),
      db.query<GateEvent>(
        `SELECT work_item_id, gate_name, result, updated_at::text AS updated_at
           FROM gates ${where('work_item_id')} ORDER BY updated_at DESC LIMIT ${String(limit)};`,
        params,
      ),
      db.query<RunEvent>(
        `SELECT work_item_id, id, status, agent_target, updated_at::text AS updated_at
           FROM runs ${where('work_item_id')} ORDER BY updated_at DESC LIMIT ${String(limit)};`,
        params,
      ),
    ]);

    return {
      status: 200,
      body: buildFeed({ transitions, comments, gates, runs, limit }),
    };
  }

  if (path === '/api/metrics') {
    // One request for the whole dashboard. Five charts each fetching their own
    // slice is five round trips for data that all comes from two tables, and a
    // dashboard that paints in five stages looks broken while it is loading.
    const windowDays = Number(url.searchParams.get('days') ?? '30');
    const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 30;

    const [transitions, gates, runs, items] = await Promise.all([
      db.query<TransitionRow>(
        `SELECT work_item_id, from_state, to_state, created_at::text AS created_at
           FROM lifecycle_transitions ORDER BY created_at ASC;`,
      ),
      db.query<{ gate_name: string; result: string | null; count: string }>(
        `SELECT gate_name, result, count(*)::text AS count FROM gates GROUP BY gate_name, result;`,
      ),
      db.query<{ status: string | null; count: string }>(
        `SELECT status, count(*)::text AS count FROM runs GROUP BY status;`,
      ),
      db.query<{ id: string; created_at: string; lifecycle_state: string }>(
        `SELECT id, created_at::text AS created_at, lifecycle_state FROM work_items;`,
      ),
    ]);

    const byCard = visitsByCard(transitions);
    const all = [...byCard.values()].flat();
    const createdAt = new Map(items.map((row) => [row.id, row.created_at]));

    return {
      status: 200,
      body: {
        windowDays: days,
        stages: stageStats(all),
        bottleneck: bottleneck(all),
        flowEfficiency: flowEfficiency(all),
        rework: rework(byCard),
        cycleTimes: [...byCard.entries()]
          .map(([id, visits]) => ({
            id,
            cycleTimeMs: cycleTime(visits),
            leadTimeMs: leadTime(visits, createdAt.get(id) ?? ''),
          }))
          .filter((entry) => entry.cycleTimeMs !== null),
        // Cumulative flow: how many cards sit in each column right now. A true
        // CFD needs a daily snapshot series, which nothing records yet — so
        // this is the current distribution and is labelled as such rather than
        // drawn as a time series with one point.
        cumulative: items.reduce<Record<string, number>>((acc, row) => {
          acc[row.lifecycle_state] = (acc[row.lifecycle_state] ?? 0) + 1;
          return acc;
        }, {}),
        gates: gates.map((row) => ({
          gate: row.gate_name,
          result: row.result ?? 'unrecorded',
          count: Number(row.count),
        })),
        runs: runs.map((row) => ({ status: row.status ?? 'unrecorded', count: Number(row.count) })),
      },
    };
  }

  if (path === '/api/wip-limits') {
    // Derived from each column's own observed throughput and time-in-column,
    // not chosen. A limit nobody can justify is a limit somebody removes the
    // first time it is inconvenient (P3-KAN-05).
    const windowDays = Number(url.searchParams.get('days') ?? '30');
    const rows = await db.query<{
      to_state: string;
      completed: string;
      mean_ms: string | null;
    }>(
      `WITH visits AS (
         SELECT work_item_id, to_state, created_at,
                lead(created_at) OVER (PARTITION BY work_item_id ORDER BY created_at) AS left_at
           FROM lifecycle_transitions
          WHERE created_at > now() - ($1 || ' days')::interval
       )
       SELECT to_state,
              count(*) FILTER (WHERE left_at IS NOT NULL)::text AS completed,
              (avg(EXTRACT(EPOCH FROM (left_at - created_at)) * 1000)
                 FILTER (WHERE left_at IS NOT NULL))::text AS mean_ms
         FROM visits GROUP BY to_state;`,
      [String(Number.isFinite(windowDays) ? windowDays : 30)],
    );

    const limits = wipLimits(
      rows.map((row) => ({
        column: row.to_state,
        completed: Number(row.completed),
        meanTimeInColumnMs: Number(row.mean_ms ?? 0),
        windowMs: (Number.isFinite(windowDays) ? windowDays : 30) * 86_400_000,
      })),
    );
    return { status: 200, body: limits };
  }

  if (path === '/api/lifecycle-states') {
    const rows = await db.query(`SELECT * FROM lifecycle_states ORDER BY sort_order ASC;`);
    return { status: 200, body: rows };
  }

  return null;
}

/**
 * An HTTP handler for the API, returning whether it took the request.
 *
 * Returning a boolean rather than always responding lets the same server carry
 * the WebSocket upgrade and, later, the built UI assets, without this module
 * needing to know about either.
 */
export function createApiHandler(
  options: ApiOptions,
): (request: IncomingMessage, response: ServerResponse) => boolean {
  return (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/api/')) return false;

    // Checked before anything is read or served. A rebinding page reaches this
    // with the attacker's own Host, so this is the line that actually holds.
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'host not allowed' }));
      return true;
    }

    const origin = request.headers.origin;
    const allowedOrigin = isAllowedOrigin(origin) ? origin : undefined;

    if (request.method === 'OPTIONS') {
      response.writeHead(allowedOrigin === undefined ? 403 : 204, {
        ...(allowedOrigin === undefined
          ? {}
          : {
              'access-control-allow-origin': allowedOrigin,
              'access-control-allow-methods': 'GET, POST, OPTIONS',
              'access-control-allow-headers': 'content-type',
              vary: 'Origin',
            }),
      });
      response.end();
      return true;
    }

    const move = /^\/api\/work-items\/([^/]+)\/move$/.exec(path);
    if (request.method === 'POST' && move !== null) {
      if (options.transition === undefined) {
        json(
          response,
          501,
          { error: 'this server was started without a transition path' },
          allowedOrigin,
        );
        return true;
      }
      const transition = options.transition;
      void (async () => {
        try {
          const body = await readBody(request);
          const column = typeof body['column'] === 'string' ? body['column'] : '';
          const outcome = await moveCard(
            {
              currentStage: async (id) => {
                const rows = await options.db.query<{ lifecycle_state: string }>(
                  `SELECT lifecycle_state FROM work_items WHERE id = $1;`,
                  [id],
                );
                return rows[0]?.lifecycle_state ?? null;
              },
              transition,
            },
            decodeURIComponent(move[1] ?? ''),
            column,
          );
          // A refused move is 200 with `moved: false`, not an error status. The
          // gate saying no is the product working, and rendering it as a failed
          // request would put "something went wrong" in front of a user whose
          // move was correctly declined for a reason they need to read.
          json(response, 200, outcome, allowedOrigin);
        } catch (error) {
          json(
            response,
            500,
            { error: error instanceof Error ? error.message : String(error) },
            allowedOrigin,
          );
        }
      })();
      return true;
    }

    if (request.method !== 'GET') {
      json(
        response,
        405,
        { error: 'the API is read-mostly; the only write is a board move' },
        allowedOrigin,
      );
      return true;
    }

    // A cross-origin GET from a non-loopback page is refused outright rather
    // than served without CORS headers. Served-and-blocked still runs the query.
    if (origin !== undefined && allowedOrigin === undefined) {
      json(response, 403, { error: 'origin not allowed' }, undefined);
      return true;
    }

    void (async () => {
      try {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
        const handled = await route(url, options);
        if (handled === null)
          json(response, 404, { error: `no route for ${url.pathname}` }, allowedOrigin);
        else json(response, handled.status, handled.body, allowedOrigin);
      } catch (error) {
        json(
          response,
          500,
          { error: error instanceof Error ? error.message : String(error) },
          allowedOrigin,
        );
      }
    })();
    return true;
  };
}

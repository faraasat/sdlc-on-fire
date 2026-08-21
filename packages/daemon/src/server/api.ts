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

export interface ApiQueryCapable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface ApiOptions {
  readonly db: ApiQueryCapable;
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
    const rows = await db.query(
      `SELECT id, type, title, status, lifecycle_state, work_type, preset, risk_level,
              parent_id, file_path, claimed_by, claim_kind, lease_expires_at,
              created_at, updated_at
         FROM work_items ORDER BY updated_at DESC LIMIT 1000;`,
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
    return { status: 200, body: { item: items[0], gates, runs, comments, transitions } };
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
              'access-control-allow-methods': 'GET, OPTIONS',
              'access-control-allow-headers': 'content-type',
              vary: 'Origin',
            }),
      });
      response.end();
      return true;
    }

    if (request.method !== 'GET') {
      json(
        response,
        405,
        { error: 'the API is read-only; write through the CLI or daemon' },
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

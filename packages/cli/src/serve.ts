/**
 * `sdlc serve` (P3-UI-01).
 *
 * Brings up the daemon's read API, the realtime WebSocket, and — if the board
 * has been built — the board itself, all on one loopback port. One port because
 * one origin: the `Host` guard then covers the entire surface, and there is no
 * second place where a cross-origin rule could be relaxed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  applySchema,
  ensureHumanActor,
  PostgresStorageAdapter,
  provisionPglite,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import {
  createApiHandler,
  createStaticHandler,
  startRealtimeServer,
  SyncEngine,
} from '@sdlc-on-fire/daemon';

const exec = promisify(execFile);

export interface ServeOptions {
  readonly root: string;
  readonly port?: number;
  readonly host?: string;
  /** Where the built board lives. Absent means look next to the installed package. */
  readonly uiDir?: string;
}

export interface ServeResult {
  readonly url: string;
  readonly port: number;
  readonly servingUi: string | null;
  /** Whether the file watcher is running — without it the board never changes. */
  readonly watching: boolean;
  /** Files reconciled at startup, catching up whatever changed while it was down. */
  readonly reconciled: number;
  close(): Promise<void>;
}

/** `git config user.email`, or undefined. Identity resolution degrades, never fails. */
async function gitEmail(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['config', 'user.email'], { cwd: root });
    const email = stdout.trim();
    return email === '' ? undefined : email;
  } catch {
    return undefined;
  }
}

/** The built board, if one is present. */
async function findUi(explicit: string | undefined): Promise<string | null> {
  const candidates: string[] = [];
  if (explicit !== undefined) candidates.push(path.resolve(explicit));

  // Installed layout: the ui package sits beside this one in node_modules.
  try {
    const require = createRequire(import.meta.url);
    candidates.push(
      path.join(path.dirname(require.resolve('@sdlc-on-fire/ui/package.json')), 'dist'),
    );
  } catch {
    // Not installed. Normal — the board is optional.
  }
  // Workspace layout, for development.
  candidates.push(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist'),
  );

  for (const candidate of candidates) {
    try {
      await fs.stat(path.join(candidate, 'index.html'));
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function serve(options: ServeOptions): Promise<ServeResult> {
  const db: ProvisionedDatabase = await provisionPglite({ workspaceRoot: options.root });
  await applySchema(db);

  const email = await gitEmail(options.root);

  // Also here, not only in `init`. A workspace scaffolded before the bootstrap
  // existed has no human actor, and telling those users to re-init to see their
  // own board would be a migration note for a problem we created. Idempotent.
  await ensureHumanActor(db, email);

  const api = createApiHandler({ db, gitEmail: email, version: 'dev' });

  const uiDir = await findUi(options.uiDir);
  const statics = uiDir === null ? null : createStaticHandler(uiDir);

  // The watcher is what closes the loop, and leaving it out is what made the
  // first working version of this command wrong in the most convincing way: the
  // API served, the socket connected, the board painted, and nothing ever
  // changed — because `sdlc new` writes a Markdown file and the database only
  // learns about it when something syncs. Every layer was individually correct
  // and the product did not work. File → sync → row → trigger → NOTIFY → socket
  // → board is the whole chain, and it is only a chain if every link is running.
  //
  // It also explains the other half of what went wrong: PGlite is
  // single-connection, so while this process holds the data directory, a second
  // `sdlc` process cannot open it. The daemon has to be the one doing the
  // writing, which is exactly what the sync engine is for.
  const store = await PostgresStorageAdapter.create(db);
  const sync = new SyncEngine({ workspaceRoot: options.root, store });

  // Reconcile before watching, in that order, for the same reason the socket
  // sends its watermark before it trusts the stream: a watcher only ever sees
  // changes made *after* it started. Files written while the daemon was down —
  // by `sdlc new`, by a `git pull`, by an editor — are invisible to it forever
  // otherwise, and the board would show a workspace that no longer exists while
  // looking perfectly healthy. Starting the watcher first would leave a window
  // where a change is neither reconciled nor observed.
  const reconciled = await sync.reconcile();
  await sync.start();

  const server = await startRealtimeServer({
    db,
    port: options.port ?? 4600,
    host: options.host ?? '127.0.0.1',
    // API first: a client route must never shadow `/api/health`.
    onRequest: (request, response) =>
      api(request, response) || (statics?.(request, response) ?? false),
  });

  return {
    url: `http://${options.host ?? '127.0.0.1'}:${String(server.port)}`,
    port: server.port,
    servingUi: uiDir,
    watching: true,
    reconciled: reconciled.length,
    close: async () => {
      await sync.stop().catch(() => undefined);
      await server.close();
      await db.close();
    },
  };
}

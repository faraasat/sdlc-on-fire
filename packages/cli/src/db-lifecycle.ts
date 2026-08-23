import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { applySchema, migrationFiles } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase, readConfig } from './commands.js';

/**
 * `sdlc db:up` / `sdlc db:down` (P6-SURFACE-02; FEAT-STORE-011, FEAT-CLI-011).
 *
 * Both names appeared in user-facing remediation text while registered nowhere
 * — the P5 audit found them, and the guard that now catches that class of defect
 * was written for exactly this pair. This is the other half: making them exist.
 *
 * **Neither starts or stops a Postgres server, and `db:down` says so out loud.**
 * [ADR-0068](../../../docs/.plan/decisions/ADR-0068-postgres-compatible-targets-no-vendored-binaries.md)
 * is explicit that we do not provision the server, the user does — so a `db:up`
 * that shelled out to `pg_ctl` or docker would be this product quietly taking
 * ownership of a process it cannot be responsible for, on a machine whose
 * Postgres may be serving something else entirely.
 *
 * What they do instead is the honest reading of the two words in a workspace
 * whose default database is embedded: `up` means *reachable, migrated and ready*,
 * and `down` means *this workspace is no longer holding it*.
 */

export interface DbUpResult {
  readonly mode: string;
  /** Data directory for PGlite; the redacted URL for a connected server. */
  readonly where: string;
  readonly migrations: number;
  /** True when this run created the store rather than finding it. */
  readonly created: boolean;
}

export async function dbUp(root: string): Promise<DbUpResult> {
  const layout = resolveWorkspaceLayout(root);
  // `layout.dataDir`, not a hand-written `.sdlcof/pgdata`. The path constants
  // live in one place for the reason `paths.ts` states out loud: two spellings
  // is how `.sdlcof/db` and `.sdlcof/database` both end up existing.
  //
  // Non-EMPTY, not merely present. `sdlc init` scaffolds the directory whether
  // or not it provisions a database, so "the folder exists" answers a different
  // question — and answering it would make `created` false on the very first
  // `db:up`, which is the one run where it is true.
  const before = await fs
    .readdir(layout.dataDir)
    .then((entries) => entries.length > 0)
    .catch(() => false);

  const { db, mode, describe } = await openWorkspaceDatabase(root);
  try {
    // Migrations are applied here rather than left for the first command that
    // happens to need a table. "The database is up" and "the database has the
    // shape this build expects" are the same claim to anyone reading the word.
    await applySchema(db);
    return {
      mode,
      where: describe,
      migrations: (await migrationFiles()).length,
      created: mode === 'pglite' && !before,
    };
  } finally {
    await db.close();
  }
}

export function formatDbUp(result: DbUpResult): string {
  const lines = [
    result.created
      ? `database created and migrated (${result.mode})`
      : `database is up and migrated (${result.mode})`,
    `  ${result.where}`,
    `  ${String(result.migrations)} migration(s) applied`,
  ];
  if (result.mode === 'connected') {
    // Stated every time. A `db:up` against a server somebody else runs is a
    // reachability check, and letting it read as "we started it" is how an
    // operator later expects `db:down` to stop it.
    lines.push('  (connected mode — this checked reachability; the server is yours to run)');
  }
  return lines.join('\n');
}

export interface DbDownResult {
  readonly mode: string;
  readonly released: boolean;
  readonly because: string;
}

export async function dbDown(root: string): Promise<DbDownResult> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  if (config === null) {
    throw new Error(`${layout.configPath} not found — run \`sdlc init\` first`);
  }

  if (config.database.mode === 'connected') {
    return {
      mode: 'connected',
      released: false,
      // Refused rather than attempted. The server predates this workspace and
      // will outlive it, and a tool that stops a database it did not start is
      // one nobody can safely run twice.
      because:
        'this workspace connects to a Postgres it does not manage (ADR-0068) — nothing to bring down here, and stopping a server you run is not ours to do',
    };
  }

  // PGlite is embedded: there is no process. What "down" can honestly mean is
  // that the lock this workspace holds is gone, so another process may open it.
  const lockPath = path.join(layout.lockDir, 'pglite.lock');
  const held = await fs
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  if (!held) {
    return { mode: 'pglite', released: false, because: 'no lock was held — nothing was open' };
  }

  await fs.rm(lockPath, { recursive: true, force: true });
  return {
    mode: 'pglite',
    released: true,
    because: 'released the workspace lock; the data directory is untouched',
  };
}

export function formatDbDown(result: DbDownResult): string {
  return [result.released ? 'database released' : 'nothing to release', `  ${result.because}`].join(
    '\n',
  );
}

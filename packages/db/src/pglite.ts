import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import lockfile from 'proper-lockfile';
import { resolveWorkspaceLayout, type WorkspaceLayout } from '@sdlc-on-fire/core';

/**
 * The PGlite fast path (ADR-0003, amended by ADR-0068).
 *
 * PGlite is Postgres compiled to WebAssembly, so this is the only provisioning
 * mode we ship: there is no platform binary and therefore no `(OS × arch)` matrix
 * to maintain. Every other supported target — a local Postgres, Docker, Supabase,
 * Neon — is reached by connection string in connected mode (`P0-DB-02`) and
 * installed by the user, not by us.
 *
 * PGlite is single-connection. The daemon must be the sole owner of the data
 * directory: a second process opening it concurrently risks WAL corruption
 * (risk R-02). That ownership is enforced here by an advisory lock rather than
 * left to convention, because "don't open it twice" is not something a comment
 * can enforce across processes.
 */

/** Minimum pgvector-capable Postgres major the schema targets. */
export const MINIMUM_SERVER_VERSION_MAJOR = 15;

/** How long a held lock stays valid without a refresh before it is considered abandoned. */
const LOCK_STALE_MS = 20_000;
/** How often the owner refreshes its lock while running. */
const LOCK_UPDATE_MS = 5_000;

export class DatabaseLockedError extends Error {
  override readonly name = 'DatabaseLockedError';
  constructor(readonly dataDir: string) {
    super(
      `the PGlite data directory at ${dataDir} is already owned by another process. ` +
        'PGlite is single-connection: only one daemon may hold it at a time. ' +
        'Stop the running daemon, or wait for an abandoned lock to expire.',
    );
  }
}

export class CapabilityError extends Error {
  override readonly name = 'CapabilityError';
  constructor(message: string) {
    super(message);
  }
}

/** What a provisioned endpoint can actually do, established by querying it — never assumed. */
export interface DatabaseCapabilities {
  /** Raw `server_version`, e.g. `17.4`. */
  readonly serverVersion: string;
  readonly serverVersionMajor: number;
  /** Whether the `vector` extension is installed and usable. */
  readonly vector: boolean;
  /** Installed pgvector version, when present. */
  readonly vectorVersion: string | null;
  /** Whether pgvector exposes the HNSW index access method the schema requires. */
  readonly hnsw: boolean;
}

/** A live, owned PGlite database. Close it to release both the connection and the lock. */
export interface ProvisionedDatabase {
  readonly mode: 'pglite';
  readonly dataDir: string;
  readonly capabilities: DatabaseCapabilities;
  /** Execute one or more statements with no parameters. */
  exec(sql: string): Promise<void>;
  /** Execute a single parameterised statement and return its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Runs `fn` inside a real transaction, serialised against other callers.
   *
   * PGlite is one connection, so concurrent callers issuing `BEGIN` as an
   * ordinary query interleave in a single session: every `BEGIN` after the first
   * is a warning, and the first `COMMIT` ends everybody's work. Queuing is what
   * makes the transaction mean anything here.
   */
  transaction<T>(
    fn: (tx: {
      query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
    }) => Promise<T>,
  ): Promise<T>;
  /**
   * Subscribe to a Postgres `NOTIFY` channel; resolves to an unsubscribe.
   *
   * On the port rather than reached around (ADR-0047), because realtime is a
   * data concern and the daemon must not hold a raw driver handle to get it.
   *
   * PGlite is a single connection, so this listener shares the session every
   * query uses. That is fine in-process and is *not* fine against a server
   * Postgres, where a dedicated `LISTEN` connection is the documented shape —
   * the connected adapter therefore opens its own, and [P3-META-01] budgets
   * them.
   */
  listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
  /** Releases the lock and shuts the database down. Idempotent. */
  close(): Promise<void>;
}

export interface ProvisionPgliteOptions {
  /** Workspace root; `.sdlcof/db` beneath it is used unless `dataDir` overrides. */
  readonly workspaceRoot: string;
  /** Explicit data directory, bypassing the workspace layout. Mainly for tests. */
  readonly dataDir?: string | undefined;
  /** Explicit lock directory. Defaults to `.sdlcof/locks`. */
  readonly lockDir?: string | undefined;
}

function resolvePaths(
  options: ProvisionPgliteOptions,
): Pick<WorkspaceLayout, 'dataDir' | 'lockDir'> {
  const workspace = resolveWorkspaceLayout(options.workspaceRoot);
  return {
    dataDir: options.dataDir ?? workspace.dataDir,
    lockDir: options.lockDir ?? workspace.lockDir,
  };
}

/**
 * Reads what the database can actually do.
 *
 * This is the deterministic disposer (ADR-0040) for "is this endpoint usable" —
 * the same shape connected mode will reuse against a user-supplied connection
 * string. Nothing here trusts a claim: pgvector's presence is established by
 * creating the extension and reading it back out of `pg_extension`, and HNSW by
 * asking `pg_am` whether the access method exists.
 */
async function probeCapabilities(pg: PGlite): Promise<DatabaseCapabilities> {
  const versionRows = await pg.query<{ server_version: string }>('SHOW server_version;');
  const serverVersion = versionRows.rows[0]?.server_version ?? '0';
  const serverVersionMajor = Number.parseInt(serverVersion.split('.')[0] ?? '0', 10);

  await pg.exec('CREATE EXTENSION IF NOT EXISTS vector;');

  const extensionRows = await pg.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector';",
  );
  const vectorVersion = extensionRows.rows[0]?.extversion ?? null;

  const amRows = await pg.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_am WHERE amname = 'hnsw';",
  );

  return {
    serverVersion,
    serverVersionMajor,
    vector: vectorVersion !== null,
    vectorVersion,
    hnsw: (amRows.rows[0]?.count ?? 0) > 0,
  };
}

/** Blocks provisioning on a capability the schema cannot do without. */
function assertUsable(capabilities: DatabaseCapabilities, dataDir: string): void {
  if (capabilities.serverVersionMajor < MINIMUM_SERVER_VERSION_MAJOR) {
    throw new CapabilityError(
      `${dataDir}: server_version ${capabilities.serverVersion} is below the minimum ` +
        `supported major ${MINIMUM_SERVER_VERSION_MAJOR}.`,
    );
  }
  if (!capabilities.vector) {
    throw new CapabilityError(
      `${dataDir}: the pgvector extension is not available. ` +
        'The bundled PGlite build ships it, so this indicates a corrupt or ' +
        'externally-created data directory.',
    );
  }
}

/**
 * Brings up the PGlite fast path: creates the data directory, takes exclusive
 * ownership of it, opens the database with pgvector loaded, and verifies the
 * capabilities the schema depends on before handing back a usable handle.
 *
 * Throws {@link DatabaseLockedError} if another process already owns the
 * directory, and {@link CapabilityError} if the database comes up but cannot do
 * what the schema requires. Both leave the lock released.
 */
export async function provisionPglite(
  options: ProvisionPgliteOptions,
): Promise<ProvisionedDatabase> {
  const { dataDir, lockDir } = resolvePaths(options);

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(lockDir, { recursive: true });

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(dataDir, {
      lockfilePath: path.join(lockDir, 'pglite.lock'),
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
    });
  } catch (cause) {
    // proper-lockfile signals contention with ELOCKED; anything else is a real
    // filesystem problem and should surface unchanged rather than be relabelled.
    if ((cause as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new DatabaseLockedError(dataDir);
    }
    throw cause;
  }

  let pg: PGlite | undefined;
  try {
    pg = await PGlite.create({ dataDir, extensions: { vector } });
    const capabilities = await probeCapabilities(pg);
    assertUsable(capabilities, dataDir);

    const db = pg;
    let closed = false;
    // Serialisation tail: transactions queue rather than interleave in the one
    // session PGlite gives us.
    let queue: Promise<unknown> = Promise.resolve();

    return {
      mode: 'pglite',
      dataDir,
      capabilities,
      async exec(sql: string): Promise<void> {
        await db.exec(sql);
      },
      async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
        const result = await db.query<T>(sql, params);
        return result.rows;
      },
      transaction<T>(
        fn: (tx: {
          query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
        }) => Promise<T>,
      ): Promise<T> {
        const run = async (): Promise<T> => {
          await db.exec('BEGIN;');
          try {
            const value = await fn({
              async query<R = Record<string, unknown>>(
                sql: string,
                params?: unknown[],
              ): Promise<R[]> {
                return (await db.query<R>(sql, params)).rows;
              },
            });
            await db.exec('COMMIT;');
            return value;
          } catch (error) {
            await db.exec('ROLLBACK;');
            throw error;
          }
        };
        const result = queue.then(run, run);
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
      async listen(
        channel: string,
        callback: (payload: string) => void,
      ): Promise<() => Promise<void>> {
        const unsubscribe = await db.listen(channel, callback);
        return async () => {
          await unsubscribe();
        };
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await db.close();
        await release?.();
      },
    };
  } catch (error) {
    // Never leave a lock behind on a failed bring-up — the next attempt would
    // hit DatabaseLockedError and blame a process that is not running.
    await pg?.close().catch(() => undefined);
    await release?.().catch(() => undefined);
    throw error;
  }
}

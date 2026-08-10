import pg from 'pg';
import {
  CapabilityError,
  MINIMUM_SERVER_VERSION_MAJOR,
  type DatabaseCapabilities,
} from './pglite.js';

/**
 * Connected mode — any Postgres-compatible endpoint by connection string
 * (P0-DB-02, [ADR-0068]).
 *
 * The decision that shapes this module: **we do not provision it.** A local
 * Postgres, Docker, Supabase, Neon — the user installs and runs it, and hands us
 * a URL. That is the whole reason the vendored-binary path was retired: no
 * `(OS × arch)` matrix, no bundled server, no install scripts of ours.
 *
 * Which means the endpoint is *not ours to trust*. It may be an old major, it
 * may lack pgvector, it may be a Postgres-compatible thing that is not Postgres.
 * So the same capability probe that guards PGlite guards this, and it reads the
 * catalog rather than believing the connection string.
 */

/** A live connection to a user-supplied Postgres-compatible endpoint. */
export interface ConnectedDatabase {
  readonly mode: 'connected';
  /** The endpoint, with any password removed. Safe to log. */
  readonly safeUrl: string;
  readonly capabilities: DatabaseCapabilities;
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly url: string;
  /** Fail the connection attempt after this long. */
  readonly connectionTimeoutMs?: number | undefined;
  /** Maximum pooled connections. The daemon is one process; it does not need many. */
  readonly maxConnections?: number | undefined;
}

export class ConnectionStringError extends Error {
  override readonly name = 'ConnectionStringError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Strips credentials from a connection string so it can be logged or shown.
 *
 * Connection strings carry passwords, and this one arrives from user config
 * headed for error messages, `sdlc config` output, and `status --json`. Printing
 * it verbatim would leak the password into terminal scrollback, CI logs, and any
 * bug report a user pastes — so redaction happens once, here, at the boundary,
 * rather than being remembered at each call site.
 */
export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') parsed.password = '***';
    return parsed.toString();
  } catch {
    // Not parseable as a URL: return a shape, never the contents. A malformed
    // string could still be `postgres://user:hunter2@…` with one bad character.
    return '(unparseable connection string)';
  }
}

/**
 * Validates the shape of a connection string before we try to dial it.
 *
 * A typo'd scheme produces a confusing driver-level error several seconds later;
 * saying "this is not a postgres:// URL" immediately is kinder and cheaper.
 */
export function assertConnectionString(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectionStringError(
      'database.url is not a valid URL — expected postgres://user:password@host:port/database',
    );
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ConnectionStringError(
      `database.url has scheme "${parsed.protocol.replace(':', '')}" — expected postgres or postgresql`,
    );
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    throw new ConnectionStringError(
      'database.url names no database — expected postgres://host:port/<database>',
    );
  }
}

async function probe(pool: pg.Pool): Promise<DatabaseCapabilities> {
  const version = await pool.query<{ server_version: string }>('SHOW server_version;');
  const serverVersion = version.rows[0]?.server_version ?? '0';
  const serverVersionMajor = Number.parseInt(serverVersion.split('.')[0] ?? '0', 10);

  // Attempt the extension, but do not fail on it: a managed endpoint may forbid
  // CREATE EXTENSION to a non-superuser while already having vector installed.
  // What matters is whether it is there afterwards, not whether we put it there.
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  } catch {
    // Reported through the probe below, not swallowed.
  }

  const extension = await pool.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector';",
  );
  const vectorVersion = extension.rows[0]?.extversion ?? null;

  const am = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_am WHERE amname = 'hnsw';",
  );

  return {
    serverVersion,
    serverVersionMajor,
    vector: vectorVersion !== null,
    vectorVersion,
    hnsw: (am.rows[0]?.count ?? 0) > 0,
  };
}

/**
 * Refuses an endpoint the schema cannot run on.
 *
 * Failing at connect time with a specific reason beats failing later at the
 * first vector query with a syntax error — the user needs to know *now* that
 * their Neon branch lacks pgvector, while they are still setting it up.
 */
function assertUsable(capabilities: DatabaseCapabilities, safeUrl: string): void {
  if (capabilities.serverVersionMajor < MINIMUM_SERVER_VERSION_MAJOR) {
    throw new CapabilityError(
      `${safeUrl}: server_version ${capabilities.serverVersion} is below the minimum ` +
        `supported major ${MINIMUM_SERVER_VERSION_MAJOR}.`,
    );
  }
  if (!capabilities.vector) {
    throw new CapabilityError(
      `${safeUrl}: the pgvector extension is not installed and could not be created. ` +
        'Install it on the server (CREATE EXTENSION vector), or use a provider image that ships it.',
    );
  }
}

/**
 * Connects to a user-supplied endpoint and verifies it can host the schema.
 *
 * No lock is taken, unlike PGlite. Postgres handles concurrent connections
 * itself, and the single-writer constraint that makes the PGlite lock necessary
 * simply does not exist here — that difference is the point of connected mode.
 */
export async function connectToPostgres(options: ConnectOptions): Promise<ConnectedDatabase> {
  assertConnectionString(options.url);
  const safeUrl = redactConnectionString(options.url);

  const pool = new pg.Pool({
    connectionString: options.url,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    max: options.maxConnections ?? 4,
  });

  let capabilities: DatabaseCapabilities;
  try {
    capabilities = await probe(pool);
    assertUsable(capabilities, safeUrl);
  } catch (cause) {
    // Never leave a pool open behind a failed connect — the process would not
    // exit, and the user would see a hang instead of the error we just raised.
    await pool.end().catch(() => undefined);
    if (cause instanceof CapabilityError || cause instanceof ConnectionStringError) throw cause;
    // Keep the driver's own error attached: "could not connect" without the
    // underlying ECONNREFUSED / 28P01 / 3D000 is not a diagnosis.
    throw new Error(`could not connect to ${safeUrl}: ${(cause as Error).message}`, { cause });
  }

  let closed = false;
  return {
    mode: 'connected',
    safeUrl,
    capabilities,

    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },

    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows as T[];
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

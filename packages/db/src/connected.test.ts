import { describe, expect, it } from 'vitest';
import {
  assertConnectionString,
  connectToPostgres,
  ConnectionStringError,
  redactConnectionString,
} from './connected.js';
import { applySchema } from './migrate.js';
import { PostgresStorageAdapter } from './postgres-adapter.js';

/**
 * Connected mode (P0-DB-02, ADR-0068).
 *
 * The live half of this suite runs against a real Postgres when
 * `SDLCOF_TEST_POSTGRES_URL` is set, and skips otherwise. It is skipped rather
 * than mocked deliberately: the entire risk of connected mode is that a real
 * server behaves unlike PGlite, and a mock reproduces exactly the assumptions
 * that would make us wrong. A skipped test is honest about not having run; a
 * mocked one would claim a verification it did not perform.
 */

// Trim and test for emptiness, not just `undefined`. CI declares the variable
// and leaves it blank when the secret is unset, so an `undefined` check alone
// runs the live suite against an empty connection string and fails for a reason
// that has nothing to do with the code.
const RAW_URL = process.env['SDLCOF_TEST_POSTGRES_URL']?.trim();
const LIVE_URL = RAW_URL === undefined || RAW_URL === '' ? undefined : RAW_URL;
const live = LIVE_URL === undefined ? describe.skip : describe;

describe('connection-string validation', () => {
  it('accepts both postgres and postgresql schemes', () => {
    expect(() => assertConnectionString('postgres://u:p@h:5432/db')).not.toThrow();
    expect(() => assertConnectionString('postgresql://u:p@h:5432/db')).not.toThrow();
  });

  it('rejects a wrong scheme with a message naming what it saw', () => {
    // A typo'd scheme otherwise surfaces as a confusing driver error seconds later.
    expect(() => assertConnectionString('mysql://u:p@h:3306/db')).toThrow(/scheme "mysql"/);
  });

  it('rejects a URL that names no database', () => {
    expect(() => assertConnectionString('postgres://u:p@h:5432')).toThrow(/names no database/);
    expect(() => assertConnectionString('postgres://u:p@h:5432/')).toThrow(/names no database/);
  });

  it('rejects something that is not a URL at all', () => {
    expect(() => assertConnectionString('not a url')).toThrow(ConnectionStringError);
  });
});

describe('redaction', () => {
  it('removes the password but keeps the endpoint legible', () => {
    const safe = redactConnectionString('postgres://alice:hunter2@db.example.com:5432/app');
    expect(safe).not.toContain('hunter2');
    expect(safe).toContain('db.example.com');
    expect(safe).toContain('alice');
  });

  it('leaves a password-free URL alone', () => {
    const url = 'postgres://alice@db.example.com:5432/app';
    expect(redactConnectionString(url)).toContain('db.example.com');
  });

  it('reveals nothing when the string will not parse', () => {
    // A malformed string can still contain a password; returning it verbatim
    // would leak the very thing this function exists to hide.
    const safe = redactConnectionString('postgres://alice:hunter2@@@broken');
    expect(safe).not.toContain('hunter2');
  });
});

live('against a real Postgres', () => {
  it('probes capabilities from the catalog rather than the URL', async () => {
    const db = await connectToPostgres({ url: LIVE_URL as string });
    try {
      expect(db.mode).toBe('connected');
      expect(db.capabilities.serverVersionMajor).toBeGreaterThanOrEqual(15);
      expect(db.capabilities.vector).toBe(true);
      expect(db.capabilities.hnsw).toBe(true);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('never exposes the password on the connection object', async () => {
    const db = await connectToPostgres({ url: LIVE_URL as string });
    try {
      // Assert on the parsed field, not on substring absence: a password can
      // legitimately equal the database name, and a substring check would then
      // fail on the path while redaction was working perfectly.
      const original = new URL(LIVE_URL as string);
      expect(original.password.length).toBeGreaterThan(0);

      const safe = new URL(db.safeUrl);
      expect(safe.password).toBe('***');
      // A blank password field would read as "no password configured".
      expect(safe.password).not.toBe('');
      expect(safe.host).toBe(original.host);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('runs the same schema PGlite runs', async () => {
    // The claim ADR-0068 rests on: one schema, two provisioning modes. If the
    // migration diverges here, "swap your database" stops being true.
    const db = await connectToPostgres({ url: LIVE_URL as string });
    try {
      await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await applySchema(db);

      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`,
      );
      const names = new Set(tables.map((row) => row.table_name));
      for (const expected of ['work_items', 'docs', 'embeddings', 'evidence', 'gates']) {
        expect(names, expected).toContain(expected);
      }
    } finally {
      await db.close();
    }
  }, 120_000);

  it('drives the StoragePort identically to PGlite', async () => {
    // The adapter is written once and must not need a per-engine branch.
    const db = await connectToPostgres({ url: LIVE_URL as string });
    try {
      const port = await PostgresStorageAdapter.create(db);
      expect(port.capabilities.fullTextSearch).toBe(true);

      await port.upsertWorkItem({
        id: 'TASK-PG',
        type: 'task',
        title: 'Connected mode',
        status: 'To Do',
        lifecycleState: 'implement',
        filePath: 'kanban/_inbox/TASK-PG.md',
        contentHash: 'h',
      });
      expect((await port.stageOf('TASK-PG'))?.lifecycleState).toBe('implement');

      await port.replaceChunks('work_items', 'TASK-PG', [
        { index: 0, text: 'a chunk about connected mode and pangolins', contentHash: 'c' },
      ]);
      const hits = await port.searchChunks('pangolins', 5);
      expect(hits).toHaveLength(1);

      // The claim/lease race must hold on real Postgres, not just PGlite —
      // this is where genuine parallel connections actually exist.
      const attempts = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          port.claim({
            workItemId: 'TASK-PG',
            actor: `racer-${String(i)}`,
            kind: 'agent',
            leaseMs: 60_000,
          }),
        ),
      );
      expect(attempts.filter((state) => state !== null)).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 120_000);

  it('refuses an endpoint whose database does not exist, with a usable message', async () => {
    const bad = (LIVE_URL as string).replace(/\/[^/]+$/, '/definitely_not_a_database');
    await expect(connectToPostgres({ url: bad, connectionTimeoutMs: 5_000 })).rejects.toThrow(
      /could not connect/,
    );
  }, 60_000);
});

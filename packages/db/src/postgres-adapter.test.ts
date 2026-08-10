import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';
import { PostgresStorageAdapter, probeStorageCapabilities } from './postgres-adapter.js';

/**
 * The Postgres adapter behind `StoragePort` (ADR-0047, P0-DB-07).
 *
 * Run against a real PGlite: the adapter's whole job is to be the one place
 * that knows SQL, so a mocked executor would test nothing but the mock.
 */

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let workspace: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-adapter-'));
  db = await provisionPglite({ workspaceRoot: workspace });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('capability probe', () => {
  it('reads the catalog rather than assuming', async () => {
    const capabilities = await probeStorageCapabilities(db);
    expect(capabilities.vectorSearch).toBe(true);
    expect(capabilities.fullTextSearch).toBe(true);
  });

  it('binds probed capabilities to the adapter, so they are never a guess', () => {
    expect(port.capabilities.fullTextSearch).toBe(true);
  });

  it('reports no full-text search when the generated column is absent', async () => {
    // A store missing the column must degrade, not throw at query time.
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-bare-'));
    const other = await provisionPglite({ workspaceRoot: bare });
    await other.exec(
      `CREATE TABLE embeddings (id bigserial primary key, source_table text, source_id text,
         chunk_index int, chunk_text text, content_hash text, model text, tombstoned_at timestamptz);`,
    );
    const capabilities = await probeStorageCapabilities(other);
    expect(capabilities.fullTextSearch).toBe(false);

    const degraded = new PostgresStorageAdapter(other, capabilities);
    await expect(degraded.searchChunks('anything', 5)).resolves.toEqual([]);

    await other.close();
    await fs.rm(bare, { recursive: true, force: true });
  }, 120_000);
});

describe('content mirror', () => {
  it('upserts a work item and reads its stage back', async () => {
    await port.upsertWorkItem({
      id: 'TASK-001',
      type: 'task',
      title: 'Export rows',
      status: 'In Progress',
      lifecycleState: 'implement',
      filePath: 'kanban/_inbox/TASK-001.md',
      contentHash: 'h1',
    });

    expect(await port.stageOf('TASK-001')).toEqual({
      lifecycleState: 'implement',
      status: 'In Progress',
    });
  });

  it('updates rather than duplicating on re-upsert', async () => {
    await port.upsertWorkItem({
      id: 'TASK-001',
      type: 'task',
      title: 'Export rows',
      status: 'Review',
      lifecycleState: 'review',
      filePath: 'kanban/_inbox/TASK-001.md',
      contentHash: 'h2',
    });

    const rows = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM work_items WHERE id = 'TASK-001';",
    );
    expect(rows[0]?.n).toBe(1);
    expect(await port.contentHashFor('work_items', 'kanban/_inbox/TASK-001.md')).toBe('h2');
  });

  it('returns null for an unmirrored path, distinguishable from a stored empty hash', async () => {
    expect(await port.contentHashFor('docs', 'docs/nope.md')).toBeNull();
  });

  it('returns null stage for an unknown work item', async () => {
    expect(await port.stageOf('TASK-404')).toBeNull();
  });

  it('lists mirrored paths for the prune pass', async () => {
    await port.upsertDoc({
      id: 'SPEC-1',
      docType: 'spec',
      filePath: 'docs/specs/a.md',
      contentHash: 'd1',
      title: 'A',
    });
    const paths = await port.mirroredPaths('docs');
    expect(paths).toContainEqual({ id: 'SPEC-1', filePath: 'docs/specs/a.md' });
  });
});

describe('chunks', () => {
  it('replaces rather than accumulates, and drops with the source', async () => {
    await port.replaceChunks('docs', 'SPEC-1', [
      { index: 0, text: 'alpha chunk about pelicans', contentHash: 'c0' },
      { index: 1, text: 'beta chunk about walruses', contentHash: 'c1' },
    ]);
    expect((await port.searchChunks('pelicans', 5)).length).toBe(1);

    await port.replaceChunks('docs', 'SPEC-1', [
      { index: 0, text: 'gamma chunk about narwhals', contentHash: 'c2' },
    ]);
    // The old chunks must be gone, not merely outranked.
    expect(await port.searchChunks('pelicans', 5)).toEqual([]);
    expect((await port.searchChunks('narwhals', 5)).length).toBe(1);

    await port.removeByPath('docs', 'docs/specs/a.md');
    expect(await port.searchChunks('narwhals', 5)).toEqual([]);
  });

  it('carries the breadcrumb through, and omits it when absent', async () => {
    await port.upsertDoc({
      id: 'SPEC-2',
      docType: 'spec',
      filePath: 'docs/specs/b.md',
      contentHash: 'd2',
    });
    await port.replaceChunks('docs', 'SPEC-2', [
      { index: 0, text: 'chunk mentioning axolotls', contentHash: 'c3', breadcrumb: 'Top › Sub' },
      { index: 1, text: 'chunk mentioning capybaras', contentHash: 'c4' },
    ]);

    const withCrumb = await port.searchChunks('axolotls', 1);
    expect(withCrumb[0]?.breadcrumb).toBe('Top › Sub');
    const without = await port.searchChunks('capybaras', 1);
    expect(without[0]?.breadcrumb).toBeUndefined();
  });

  it('rolls back a failed chunk replacement instead of leaving the source empty', async () => {
    await port.replaceChunks('docs', 'SPEC-2', [
      { index: 0, text: 'stable chunk about ocelots', contentHash: 'c5' },
    ]);

    // `chunk_index` is NOT NULL — this insert fails midway through the batch.
    await expect(
      port.replaceChunks('docs', 'SPEC-2', [
        { index: 0, text: 'replacement one', contentHash: 'c6' },
        { index: null as unknown as number, text: 'replacement two', contentHash: 'c7' },
      ]),
    ).rejects.toThrow();

    // A crash mid-replace must not leave the document indexed as zero chunks.
    expect((await port.searchChunks('ocelots', 5)).length).toBe(1);
  });
});

describe('the seam itself', () => {
  it('exposes no way to run arbitrary SQL', () => {
    // The failure ADR-0047 names by name: a `query` escape hatch would make
    // every caller a Postgres caller again and reduce the port to "Postgres
    // with extra steps". Guarding it here because the temptation is structural.
    expect((port as unknown as Record<string, unknown>)['query']).toBeUndefined();
    expect((port as unknown as Record<string, unknown>)['exec']).toBeUndefined();
  });

  it('rejects a table name that is not a mirror table', async () => {
    // Identifiers cannot be parameterised, and the type system is not a control
    // at a SQL boundary reachable from parsed frontmatter.
    await expect(port.contentHashFor('work_items; DROP TABLE docs' as never, 'x')).rejects.toThrow(
      /unknown mirror table/,
    );
  });
});

describe('claim / lease (P0-DB-08, ADR-0048)', () => {
  beforeAll(async () => {
    await port.upsertWorkItem({
      id: 'TASK-CLAIM',
      type: 'task',
      title: 'Claimable',
      status: 'To Do',
      lifecycleState: 'implement',
      filePath: 'kanban/_inbox/TASK-CLAIM.md',
      contentHash: 'hc',
    });
  });

  it('grants a claim on an unclaimed item', async () => {
    const state = await port.claim({
      workItemId: 'TASK-CLAIM',
      actor: 'agent-a',
      kind: 'agent',
      leaseMs: 60_000,
    });
    expect(state?.claimedBy).toBe('agent-a');
    expect(state?.claimKind).toBe('agent');
  });

  it('refuses a second actor while the lease is live', async () => {
    // The race ADR-0048 exists to close: an advisory status field would let
    // both actors read "todo" and both write "in progress".
    const state = await port.claim({
      workItemId: 'TASK-CLAIM',
      actor: 'agent-b',
      kind: 'agent',
      leaseMs: 60_000,
    });
    expect(state).toBeNull();
    expect((await port.claimOf('TASK-CLAIM'))?.claimedBy).toBe('agent-a');
  });

  it('lets exactly one of many concurrent claimants win', async () => {
    await port.releaseClaim('TASK-CLAIM', 'agent-a');

    const attempts = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        port.claim({
          workItemId: 'TASK-CLAIM',
          actor: `racer-${String(i)}`,
          kind: 'agent',
          leaseMs: 60_000,
        }),
      ),
    );
    const winners = attempts.filter((state) => state !== null);
    expect(winners).toHaveLength(1);
  });

  it('renews rather than fails when the holder re-claims', async () => {
    const holder = (await port.claimOf('TASK-CLAIM'))?.claimedBy;
    expect(holder).toBeDefined();

    const before = (await port.claimOf('TASK-CLAIM'))?.leaseExpiresAt;
    const renewed = await port.claim({
      workItemId: 'TASK-CLAIM',
      actor: holder as string,
      kind: 'agent',
      leaseMs: 600_000,
    });
    expect(renewed?.claimedBy).toBe(holder);
    expect(new Date(renewed?.leaseExpiresAt ?? 0).getTime()).toBeGreaterThan(
      new Date(before ?? 0).getTime(),
    );
  });

  it('frees the item once the lease expires, without anyone releasing it', async () => {
    // A crashed actor must not hold work forever.
    const holder = (await port.claimOf('TASK-CLAIM'))?.claimedBy as string;
    await port.releaseClaim('TASK-CLAIM', holder);

    await port.claim({
      workItemId: 'TASK-CLAIM',
      actor: 'crashed-actor',
      kind: 'agent',
      leaseMs: -1_000, // already expired
    });

    expect(await port.claimOf('TASK-CLAIM')).toBeNull();
    const taken = await port.claim({
      workItemId: 'TASK-CLAIM',
      actor: 'next-actor',
      kind: 'human',
      leaseMs: 60_000,
    });
    expect(taken?.claimedBy).toBe('next-actor');
  });

  it('refuses to release a claim the caller does not hold', async () => {
    // Releasing someone else's claim is a break-claim, which ADR-0048 requires
    // to be an audited path rather than a side effect of calling release.
    expect(await port.releaseClaim('TASK-CLAIM', 'not-the-holder')).toBe(false);
    expect(await port.claimOf('TASK-CLAIM')).not.toBeNull();

    expect(await port.releaseClaim('TASK-CLAIM', 'next-actor')).toBe(true);
    expect(await port.claimOf('TASK-CLAIM')).toBeNull();
  });

  it('returns null for an unknown work item rather than granting a claim', async () => {
    expect(
      await port.claim({
        workItemId: 'TASK-404',
        actor: 'agent-a',
        kind: 'agent',
        leaseMs: 60_000,
      }),
    ).toBeNull();
  });
});

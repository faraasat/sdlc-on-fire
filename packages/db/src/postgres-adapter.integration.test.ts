import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';
import { PostgresStorageAdapter, probeStorageCapabilities } from './postgres-adapter.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

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
  await fs.rm(workspace, { recursive: true, force: true, ...RM_RETRY });
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
    await fs.rm(bare, { recursive: true, force: true, ...RM_RETRY });
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

describe('hash-chained audit log (P0-DB-06, ADR-0030)', () => {
  it('chains each entry to the one before it', async () => {
    const first = await port.appendAudit({ action: 'gate.opened', targetId: 'TASK-1' });
    const second = await port.appendAudit({ action: 'gate.closed', targetId: 'TASK-1' });

    expect(first.prevHash).toBeNull(); // genesis
    expect(second.prevHash).toBe(first.recordHash);
    expect(second.recordHash).not.toBe(first.recordHash);
  });

  it('verifies a chain it built itself', async () => {
    const result = await port.verifyAuditChain();
    expect(result.ok).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(result.brokenAt).toEqual([]);
  });

  it('gives identical entries different hashes, because the link differs', async () => {
    // Otherwise two identical actions would be interchangeable in the chain,
    // and reordering them would go undetected.
    const a = await port.appendAudit({ action: 'noop' });
    const b = await port.appendAudit({ action: 'noop' });
    expect(a.recordHash).not.toBe(b.recordHash);
  });

  it('serialises concurrent appends into one unforked chain', async () => {
    // Two writers reading the same prev_hash fork the chain permanently — the
    // log is append-only, so a fork can never be repaired.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => port.appendAudit({ action: `concurrent-${String(i)}` })),
    );
    expect((await port.verifyAuditChain()).ok).toBe(true);
  });

  it('detects an edited row', async () => {
    await port.appendAudit({ action: 'will-be-tampered', targetId: 'T' });
    const target = await db.query<{ id: number }>(
      "SELECT id FROM audit_log WHERE action = 'will-be-tampered';",
    );
    const id = target[0]?.id;
    expect(id).toBeDefined();

    // Rewrite history without touching the hashes — the classic tamper.
    await db.query("UPDATE audit_log SET action = 'innocent' WHERE id = $1;", [id]);

    const result = await port.verifyAuditChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toContain(id);
    expect(result.reason).toMatch(/audit chain broken/);
  });

  it('detects a row deleted from the middle of the chain', async () => {
    // Removing a link leaves its successor pointing at a hash no row carries.
    // Start from a clean chain so this tests deletion, not the earlier tamper.
    await db.query('DELETE FROM audit_log;');
    for (const action of ['one', 'two', 'three']) {
      await port.appendAudit({ action });
    }
    expect((await port.verifyAuditChain()).ok).toBe(true);

    await db.query("DELETE FROM audit_log WHERE action = 'two';");
    const after = await port.verifyAuditChain();
    expect(after.ok).toBe(false);
    expect(after.brokenAt.length).toBeGreaterThan(0);
  });

  it('cannot detect truncation of the tail — stated, not pretended', async () => {
    // A known and unavoidable property of a bare hash chain: lopping off the
    // last rows leaves a shorter but internally consistent chain. Detecting it
    // needs an anchor kept outside the log (an expected tip or length), which
    // this table does not yet have. Asserting the real behaviour here so nobody
    // reads "hash-chained" as "tamper-proof against deletion".
    await db.query('DELETE FROM audit_log;');
    for (const action of ['a', 'b', 'c']) await port.appendAudit({ action });

    const tip = await db.query<{ id: number }>(
      'SELECT id FROM audit_log ORDER BY id DESC LIMIT 1;',
    );
    await db.query('DELETE FROM audit_log WHERE id = $1;', [tip[0]?.id]);

    const after = await port.verifyAuditChain();
    expect(after.ok).toBe(true);
    expect(after.checked).toBe(2);
  });
});

describe('token budgets (P0-DB-05, ADR-0020)', () => {
  const now = new Date('2026-08-10T12:00:00.000Z');
  const later = new Date('2026-08-10T12:30:00.000Z');

  beforeAll(async () => {
    await port.setBudget({
      scope: 'agent',
      scopeId: 'agent-a',
      windowStart: new Date('2026-08-10T11:00:00.000Z'),
      windowEnd: new Date('2026-08-10T13:00:00.000Z'),
      limitTokens: 1_000,
    });
  });

  it('reports a configured window', async () => {
    const state = await port.budgetFor('agent', 'agent-a', now);
    expect(state?.limitTokens).toBe(1_000);
    expect(state?.remainingTokens).toBe(1_000);
  });

  it('returns null outside the window rather than silently reusing it', async () => {
    // A budget that leaks past its window is not a window.
    expect(
      await port.budgetFor('agent', 'agent-a', new Date('2026-08-10T14:00:00.000Z')),
    ).toBeNull();
  });

  it('charges and decrements', async () => {
    const state = await port.chargeTokens({
      scope: 'agent',
      scopeId: 'agent-a',
      tokens: 400,
      at: now,
    });
    expect(state?.usedTokens).toBe(400);
    expect(state?.remainingTokens).toBe(600);
  });

  it('refuses a charge that would exceed the limit, and records nothing', async () => {
    const before = await port.budgetFor('agent', 'agent-a', now);
    const denied = await port.chargeTokens({
      scope: 'agent',
      scopeId: 'agent-a',
      tokens: 5_000,
      at: now,
    });
    expect(denied).toBeNull();

    // Partial spend on a refused charge would be the worst of both outcomes.
    const after = await port.budgetFor('agent', 'agent-a', now);
    expect(after?.usedTokens).toBe(before?.usedTokens);
  });

  it('cannot be overspent by concurrent charges', async () => {
    // Read-then-write lets two agents both see room and both spend it — a
    // budget that concurrency can overrun is an estimate wearing a limit's name.
    await port.setBudget({
      scope: 'agent',
      scopeId: 'racer',
      windowStart: new Date('2026-08-10T11:00:00.000Z'),
      windowEnd: new Date('2026-08-10T13:00:00.000Z'),
      limitTokens: 1_000,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        port.chargeTokens({ scope: 'agent', scopeId: 'racer', tokens: 100, at: later }),
      ),
    );

    expect(results.filter((r) => r !== null)).toHaveLength(10);
    const final = await port.budgetFor('agent', 'racer', later);
    expect(final?.usedTokens).toBe(1_000);
    expect(final?.remainingTokens).toBe(0);
  });

  it('returns null when no budget is configured, distinguishable from an exhausted one', async () => {
    // "No budget" and "budget spent" are different answers; collapsing them
    // would either block unbudgeted work or wave through exhausted work.
    expect(await port.budgetFor('agent', 'nobody', now)).toBeNull();
    expect(
      await port.chargeTokens({ scope: 'agent', scopeId: 'nobody', tokens: 1, at: now }),
    ).toBeNull();
  });
});

describe('already-happened ledger (P1-AGENT-04, ADR-0039)', () => {
  const action = { key: 'k-pr-1', workItemId: 'FEAT-1', stage: 'review', action: 'pr_create' };

  it('grants the first caller the right to act', async () => {
    const claim = await port.claimAction(action);
    expect(claim.first).toBe(true);
  });

  it('refuses a second attempt and replays the original outcome', async () => {
    // A resumed run must get the PR url it opened last time, not an error
    // about a duplicate — and certainly not a second PR.
    await port.recordActionResult(action.key, { url: 'https://example.com/pr/7' });

    const again = await port.claimAction(action);
    expect(again.first).toBe(false);
    expect(again.result).toEqual({ url: 'https://example.com/pr/7' });
  });

  it('lets exactly one of many concurrent resumes act', async () => {
    // Two runs resuming after the same crash both read "not yet done" before
    // either writes. That is the race this table exists to lose.
    const key = { ...action, key: 'k-race' };
    const attempts = await Promise.all(Array.from({ length: 12 }, () => port.claimAction(key)));
    expect(attempts.filter((a) => a.first)).toHaveLength(1);
  });

  it('treats a different action on the same item as unclaimed', async () => {
    const comment = { ...action, key: 'k-comment', action: 'pr_comment' };
    expect((await port.claimAction(comment)).first).toBe(true);
  });
});

/**
 * The shape `packages/context`'s `toSearchQuery` produces.
 *
 * Rebuilt here rather than imported: `db` must not depend on `context`, and a
 * test that reached across the layering to avoid five lines would be arguing
 * for an import the architecture does not allow.
 */
function orQuery(text: string): string {
  return [
    ...new Set(
      text
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .trim()
        .split(/\s+/)
        .map((term) => term.toLowerCase())
        .filter(Boolean),
    ),
  ]
    .slice(0, 40)
    .join(' | ');
}

describe('searchChunks over a realistic query (A-03 regression)', () => {
  it('finds a chunk from a whole card body, not just a single word', async () => {
    await port.replaceChunks('docs', 'FEAT-900', [
      {
        index: 0,
        text: 'The importer retries three times with exponential backoff. Rows that fail to parse are reported with their line number.',
        contentHash: 'h900',
      },
    ]);

    const card =
      'Add CSV import to the ledger. The importer should retry transient failures ' +
      'three times with exponential backoff, and report any row it cannot parse ' +
      'along with its line number so a user can fix the source file.';

    // Before the fix this returned zero rows: `websearch_to_tsquery` ANDs, so a
    // forty-term query demanded forty stems in one chunk. Every existing test
    // searched for one invented word, so the suite was green and retrieval was
    // returning nothing for anything a user would actually type.
    const hits = await port.searchChunks(orQuery(card), 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceId).toBe('FEAT-900');
  });

  it('returns nothing when the query shares no terms with the corpus', async () => {
    const port = await PostgresStorageAdapter.create(db);
    // OR must not degrade into "match everything": a query about something else
    // still has to miss.
    expect(await port.searchChunks(orQuery('quokka wombat'), 5)).toEqual([]);
  });
});

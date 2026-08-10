import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { createTsvectorRetriever } from '@sdlc-on-fire/context';
import { SyncEngine, UNEMBEDDED_MODEL } from './sync-engine.js';

/**
 * Content retrieval, end to end against a real PGlite.
 *
 * These are the tests P0-SPIKE-02 found missing. The previous suite passed with
 * an empty `embeddings` table and a retriever that searched titles, because
 * nothing ever asserted that a *body* sentence could be found. A stub store
 * would have kept passing too — the defects were in the SQL and the schema, so
 * only a real engine can dispose of them.
 */

let db: ProvisionedDatabase;
let workspace: string;

const store = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
    db.query<T>(sql, params),
};

const SPEC = `---
id: SPEC-1
title: Nothing about the body appears in this title
---

# Export pipeline

The exporter streams rows to disk in batches.

## Failure handling

When the sink rejects a batch we retry with backoff, then quarantine the
offending rows into a dead-letter file for later inspection.
`;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chunk-retrieval-ws-'));
  db = await provisionPglite({ workspaceRoot: workspace });
  await applySchema(db);

  await fs.mkdir(path.join(workspace, 'docs', 'specs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'docs', 'specs', 'export.md'), SPEC, 'utf8');

  const engine = new SyncEngine({ workspaceRoot: workspace, store });
  await engine.reconcile();
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('chunk persistence (D3)', () => {
  it('writes body chunks the sync pipeline used to discard', async () => {
    const rows = await store.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM embeddings WHERE source_id = 'SPEC-1';",
    );
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
  });

  it('marks chunks unembedded rather than naming a model that never ran', async () => {
    const rows = await store.query<{ model: string; embedding: unknown }>(
      "SELECT model, embedding FROM embeddings WHERE source_id = 'SPEC-1' LIMIT 1;",
    );
    expect(rows[0]?.model).toBe(UNEMBEDDED_MODEL);
    expect(rows[0]?.embedding).toBeNull();
  });

  it('carries the heading breadcrumb so a section is findable by its heading', async () => {
    const rows = await store.query<{ heading_breadcrumb: string | null }>(
      `SELECT heading_breadcrumb FROM embeddings
        WHERE source_id = 'SPEC-1' AND chunk_text ILIKE '%dead-letter%' LIMIT 1;`,
    );
    expect(rows[0]?.heading_breadcrumb).toContain('Failure handling');
  });
});

describe('retrieval over content, not titles (D3)', () => {
  const retrieve = () => createTsvectorRetriever(store);

  it('finds a chunk by a phrase that appears only in the body', async () => {
    // "quarantine" is nowhere in the title or frontmatter. Under the old
    // title-only retriever this returned nothing at all.
    const hits = await retrieve()('quarantine dead-letter', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.text).toContain('quarantine');
  });

  it('returns the chunk body as pack text, not the document title', async () => {
    const hits = await retrieve()('exporter streams rows batches', 5);
    expect(hits[0]?.text).toContain('streams rows to disk');
    expect(hits[0]?.text).not.toBe('Nothing about the body appears in this title');
  });

  it('identifies a hit by source and chunk, so two chunks of one doc are distinct', async () => {
    const hits = await retrieve()('export batches retry backoff quarantine', 10);
    const ids = hits.map((hit) => hit.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^SPEC-1#\d+$/);
  });

  it('reports token cost from the text it actually returns', async () => {
    const hits = await retrieve()('quarantine', 1);
    const hit = hits[0];
    expect(hit).toBeDefined();
    expect(hit?.tokens).toBe(Math.ceil((hit?.text.length ?? 0) / 4));
  });
});

describe('the stored tsvector column (D1/D2)', () => {
  it('exists as a generated column rather than an expression index', async () => {
    const rows = await store.query<{ is_generated: string }>(
      `SELECT is_generated FROM information_schema.columns
        WHERE table_name = 'embeddings' AND column_name = 'chunk_tsv';`,
    );
    expect(rows[0]?.is_generated).toBe('ALWAYS');
  });

  it('is applicable to the retriever query shape', async () => {
    // What matters here is that the GIN index *can* serve this predicate — that
    // the query the retriever actually issues is indexable. Whether the planner
    // prefers it is a cost decision that depends on corpus size, and on a small
    // table a sequential scan is genuinely cheaper: GIN has a high startup cost.
    // Forcing the choice tests applicability without asserting that the planner
    // is wrong. The size at which it flips, and the payoff, is P0-SPIKE-02's job.
    await store.query('SET enable_seqscan = off;');
    try {
      const plan = await store.query<Record<string, string>>(
        `EXPLAIN SELECT source_id FROM embeddings
          WHERE chunk_tsv @@ websearch_to_tsquery('english', 'quarantine')
          ORDER BY ts_rank_cd(chunk_tsv, websearch_to_tsquery('english', 'quarantine')) DESC
          LIMIT 5;`,
      );
      const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
      expect(text).toContain('embeddings_chunk_tsv_idx');
    } finally {
      await store.query('SET enable_seqscan = on;');
    }
  });

  it('backs the title columns too', async () => {
    for (const table of ['work_items', 'docs']) {
      const rows = await store.query<{ is_generated: string }>(
        `SELECT is_generated FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'title_tsv';`,
        [table],
      );
      expect(rows[0]?.is_generated, table).toBe('ALWAYS');
    }
  });
});

describe('chunk lifecycle', () => {
  it('replaces chunks on edit instead of accumulating stale ones', async () => {
    const before = await store.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM embeddings WHERE source_id = 'SPEC-1';",
    );

    await fs.writeFile(
      path.join(workspace, 'docs', 'specs', 'export.md'),
      SPEC.replace('quarantine', 'isolate'),
      'utf8',
    );
    const engine = new SyncEngine({ workspaceRoot: workspace, store });
    await engine.reconcile();

    const after = await store.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM embeddings WHERE source_id = 'SPEC-1';",
    );
    expect(after[0]?.n).toBe(before[0]?.n);

    // The old wording must no longer be retrievable.
    const stale = await createTsvectorRetriever(store)('quarantine', 5);
    expect(stale).toHaveLength(0);
    const fresh = await createTsvectorRetriever(store)('isolate', 5);
    expect(fresh.length).toBeGreaterThan(0);
  });

  it('removes chunks when the source file is deleted', async () => {
    await fs.rm(path.join(workspace, 'docs', 'specs', 'export.md'));
    const engine = new SyncEngine({ workspaceRoot: workspace, store });
    await engine.reconcile();

    const rows = await store.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM embeddings WHERE source_id = 'SPEC-1';",
    );
    expect(rows[0]?.n).toBe(0);
  });
});

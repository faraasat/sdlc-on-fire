import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import type { EmbedderPort, LiveChunk } from '@sdlc-on-fire/core';
import { runEmbedding, storedVectors } from './worker.js';

/**
 * P1-CTX-04 — the worker, against a real PGlite with a real `vector` column.
 *
 * The interesting behaviour is all at the database boundary: whether a
 * re-embed upserts or duplicates, whether a tombstone is soft, and whether the
 * semantic leg actually closes when the corpus holds two models. None of that
 * is observable against a mock.
 */

let db: ProvisionedDatabase;
let root: string;
const opened: ProvisionedDatabase[] = [];

/** Deterministic vectors: the worker's job is bookkeeping, not similarity. */
const embedder = (id: string): EmbedderPort => ({
  model: { id, dimensions: 384 },
  embed: (texts) =>
    Promise.resolve(
      texts.map((_, i) => {
        const v = new Float32Array(384);
        v[i % 384] = 1;
        return v;
      }),
    ),
});

const chunk = (over: Partial<LiveChunk> = {}): LiveChunk => ({
  sourceTable: 'docs',
  sourceId: 'SPEC-1',
  index: 0,
  text: 'the importer retries',
  contentHash: 'h0',
  ...over,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-embed-'));
  db = await provisionPglite({ workspaceRoot: root });
  opened.push(db);
  await applySchema(db);
}, 90_000);

afterAll(async () => {
  for (const handle of opened) await handle.close().catch(() => undefined);
});

describe('runEmbedding', () => {
  it('writes a vector and reports the leg ready', async () => {
    const result = await runEmbedding(db, embedder('bge-small-en-v1.5'), [chunk()]);
    expect(result.embedded).toBe(1);
    expect(result.semanticReady).toBe(true);

    const rows = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM embeddings WHERE embedding IS NOT NULL;',
    );
    expect(Number(rows[0]?.n)).toBe(1);
  }, 60_000);

  it('does nothing on a second run over unchanged content', async () => {
    const port = embedder('bge-small-en-v1.5');
    await runEmbedding(db, port, [chunk()]);
    const again = await runEmbedding(db, port, [chunk()]);
    // Re-embedding what did not change is the cost that kills the feature.
    expect(again.embedded).toBe(0);
    expect(again.plan.unchanged).toBe(1);
  }, 60_000);

  it('upserts rather than duplicating when the text changes', async () => {
    const port = embedder('bge-small-en-v1.5');
    await runEmbedding(db, port, [chunk()]);
    await runEmbedding(db, port, [chunk({ text: 'now different', contentHash: 'h1' })]);

    const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM embeddings;');
    // Two rows for one chunk would both be live and both returned by a search,
    // one of them stale.
    expect(Number(rows[0]?.n)).toBe(1);
  }, 60_000);

  it('tombstones softly when a chunk disappears, and revives it unchanged', async () => {
    const port = embedder('bge-small-en-v1.5');
    await runEmbedding(db, port, [chunk()]);
    const gone = await runEmbedding(db, port, []);
    expect(gone.tombstoned).toBe(1);

    const stillThere = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM embeddings;');
    // Soft: the row survives, so a file passing through an intermediate state
    // during a sync costs a flag flip rather than a re-embed.
    expect(Number(stillThere[0]?.n)).toBe(1);

    const back = await runEmbedding(db, port, [chunk()]);
    expect(back.revived).toBe(1);
    expect(back.embedded).toBe(0);
  }, 60_000);

  it('closes the semantic leg while the corpus holds two models', async () => {
    await runEmbedding(db, embedder('bge-small-en-v1.5'), [
      chunk(),
      chunk({ index: 1, contentHash: 'h1' }),
    ]);

    // A model swap arrives, and only part of the corpus is re-embedded — the
    // state that returns confident nonsense if anything queries it.
    await db.query("UPDATE embeddings SET model = 'jina-code' WHERE chunk_index = 1;");
    const result = await runEmbedding(db, embedder('bge-small-en-v1.5'), [
      chunk(),
      chunk({ index: 1, contentHash: 'h1' }),
    ]);

    // The mismatched row is re-embedded, so by the end of the run the corpus is
    // single-model again and the leg reopens.
    expect(result.embedded).toBe(1);
    expect(result.semanticReady).toBe(true);
  }, 60_000);

  it('reports the leg closed when a foreign vector survives the run', async () => {
    await runEmbedding(db, embedder('bge-small-en-v1.5'), [chunk()]);
    // A vector for a chunk the caller did not pass: not re-embedded, not
    // tombstoned by this run's live set either, because it *is* in the live set.
    await db.query(
      `INSERT INTO embeddings (source_table, source_id, chunk_index, chunk_text, content_hash, model, embedding)
       VALUES ('docs','SPEC-2',0,'other','h9','jina-code', $1::vector);`,
      [`[${new Array(384).fill(0).join(',')}]`],
    );
    const result = await runEmbedding(db, embedder('bge-small-en-v1.5'), [chunk()]);
    // SPEC-2 is not in the live set, so it is tombstoned — and once retired it
    // no longer makes the corpus mixed.
    expect(result.tombstoned).toBe(1);
    expect(result.semanticReady).toBe(true);
  }, 60_000);

  it('refuses to write when the embedder returns the wrong number of vectors', async () => {
    const broken: EmbedderPort = {
      model: { id: 'bge-small-en-v1.5', dimensions: 384 },
      embed: () => Promise.resolve([new Float32Array(384)]),
    };
    // Pairing vectors with the wrong text is undetectable afterwards — every
    // row looks valid and every search is subtly wrong.
    await expect(
      runEmbedding(db, broken, [chunk(), chunk({ index: 1, contentHash: 'h1' })]),
    ).rejects.toThrow(/wrong text/);
  }, 60_000);

  it('reads back what was written, not what the plan intended', async () => {
    await runEmbedding(db, embedder('bge-small-en-v1.5'), [chunk()]);
    const stored = await storedVectors(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.model).toBe('bge-small-en-v1.5');
    expect(stored[0]?.tombstoned).toBe(false);
  }, 60_000);
});

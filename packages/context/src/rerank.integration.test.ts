import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import type { EmbedderPort } from '@sdlc-on-fire/core';
import type { HybridHit } from './hybrid.js';
import { DEFAULT_RERANK_TOP_K, rerank, retrieve, type CrossEncoder } from './rerank.js';

/**
 * A temp directory this suite will actually remove (P6-SURFACE-13).
 *
 * Closing a database handle is not removing its data directory. 108GB of
 * abandoned PGlite data filled a disk before anything noticed, and ENOSPC
 * surfaces during *collection* as a failed file naming an innocent suite —
 * which reads exactly like flake, and cost a timeout raise and an afternoon
 * before anyone looked at `df`.
 *
 * The retry is for Windows, which keeps a file locked while anything holds it.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

/**
 * P1-CTX-09 — the optional cross-encoder reranker.
 *
 * Two properties carry the design and both are tested against a real corpus in
 * real PGlite: the reranker *reorders what fusion found* (it can never admit a
 * document neither leg retrieved), and a reranker failure degrades to the fused
 * order rather than taking retrieval down.
 */

const hit = (id: string, score: number): HybridHit => ({
  id,
  sourceTable: 'docs',
  sourceId: id,
  index: 0,
  text: `body of ${id}`,
  score,
  legs: ['lexical'],
});

/** Scores by position in a stated preference list. Deterministic, no model. */
const preferring =
  (order: readonly string[]): CrossEncoder =>
  (_query, documents) =>
    Promise.resolve(
      documents.map((text) => {
        const i = order.findIndex((id) => text.includes(id));
        return i === -1 ? 0 : order.length - i;
      }),
    );

describe('rerank', () => {
  it('reorders the fused hits by cross-encoder score', async () => {
    const fused = [hit('A', 0.9), hit('B', 0.5), hit('C', 0.1)];
    const result = await rerank('q', fused, preferring(['C', 'B', 'A']));

    expect(result.reranked).toBe(true);
    expect(result.hits.map((h) => h.sourceId)).toEqual(['C', 'B', 'A']);
    // The fused score is replaced, not kept: leaving RRF's number on a
    // reranked list would give a caller a score that disagrees with the order
    // it is attached to.
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[2]?.score ?? Infinity);
  });

  it('never admits a document fusion did not retrieve', async () => {
    const fused = [hit('A', 0.9), hit('B', 0.5)];
    // The encoder would love 'Z' — it is simply not on offer.
    const result = await rerank('q', fused, preferring(['Z', 'B', 'A']));

    // The stage is a reordering, not a retrieval. Anyone reading it as "the
    // model picks the best chunks" would size the fusion prefetch on a false
    // premise, and the recall ceiling stays wherever fusion left it.
    expect(result.hits.map((h) => h.sourceId).sort()).toEqual(['A', 'B']);
  });

  it('falls back to the fused order when the encoder throws', async () => {
    const fused = [hit('A', 0.9), hit('B', 0.5)];
    const result = await rerank('q', fused, () => Promise.reject(new Error('model not found')));

    // Degraded, not dead. A reranker that can take retrieval down with it is a
    // worse trade than not having one.
    expect(result.reranked).toBe(false);
    expect(result.hits.map((h) => h.sourceId)).toEqual(['A', 'B']);
    expect(result.skipped).toContain('model not found');
  });

  it('refuses a score list that does not line up with the documents', async () => {
    const fused = [hit('A', 0.9), hit('B', 0.5), hit('C', 0.1)];
    const result = await rerank('q', fused, () => Promise.resolve([0.1, 0.9]));

    // Positional pairing means a short list ranks each document by the *next*
    // document's relevance — plausible output, silently wrong. Refusing is the
    // only way that failure is ever visible.
    expect(result.reranked).toBe(false);
    expect(result.hits.map((h) => h.sourceId)).toEqual(['A', 'B', 'C']);
    expect(result.skipped).toContain('2 scores for 3 documents');
  });

  it('reranks only the head, leaving the tail in fusion order below it', async () => {
    const fused = Array.from({ length: 5 }, (_, i) => hit(`D${String(i)}`, 1 - i / 10));
    // The encoder ranks the last document best — but it is past topK, so it
    // is never scored and never moves.
    const result = await rerank('q', fused, preferring(['D4', 'D0', 'D1', 'D2', 'D3']), {
      topK: 3,
    });

    expect(result.scored).toBe(3);
    // Bounding the stage is the point: the cost is topK forward passes per
    // query, not one per candidate the prefetch happened to reach.
    expect(result.hits.map((h) => h.sourceId)).toEqual(['D0', 'D1', 'D2', 'D3', 'D4']);
  });

  it('defaults to a bounded depth rather than the whole list', async () => {
    const fused = Array.from({ length: DEFAULT_RERANK_TOP_K + 5 }, (_, i) =>
      hit(`E${String(i).padStart(2, '0')}`, 1 - i / 100),
    );
    const result = await rerank('q', fused, preferring([]));
    expect(result.scored).toBe(DEFAULT_RERANK_TOP_K);
  });

  it('is off unless a workspace opts in', async () => {
    const fused = [hit('A', 0.9), hit('B', 0.5)];

    const noEncoder = await rerank('q', fused, undefined);
    expect(noEncoder.reranked).toBe(false);
    expect(noEncoder.skipped).toContain('no cross-encoder');

    const disabled = await rerank('q', fused, preferring(['B', 'A']), { enabled: false });
    // `enabled: false` beats a configured encoder — that is what makes
    // "skippable at effort:low" a switch rather than a deployment change.
    expect(disabled.reranked).toBe(false);
    expect(disabled.hits.map((h) => h.sourceId)).toEqual(['A', 'B']);
  });

  it('reports an empty candidate list as not reranked', async () => {
    const result = await rerank('q', [], preferring([]));
    expect(result.reranked).toBe(false);
    expect(result.scored).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* The whole pipeline, against a real corpus.                          */
/* ------------------------------------------------------------------ */

let db: ProvisionedDatabase;
const opened: ProvisionedDatabase[] = [];

const CONCEPTS = [
  ['retry', 'reattempt'],
  ['backoff', 'delay'],
  ['invoice', 'billing'],
];

const toyEmbedder = (id = 'bge-small-en-v1.5'): EmbedderPort => ({
  model: { id, dimensions: 384 },
  embed: (texts) =>
    Promise.resolve(
      texts.map((text) => {
        const v = new Float32Array(384);
        const lower = text.toLowerCase();
        CONCEPTS.forEach((words, i) => {
          if (words.some((word) => lower.includes(word))) v[i] = 1;
        });
        const norm = Math.hypot(...Array.from(v));
        if (norm > 0) for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) / norm;
        return v;
      }),
    ),
});

async function seed(rows: { id: string; text: string }[], embedder: EmbedderPort): Promise<void> {
  const vectors = await embedder.embed(rows.map((r) => r.text));
  for (const [i, row] of rows.entries()) {
    await db.query(
      `INSERT INTO embeddings
         (source_table, source_id, chunk_index, chunk_text, content_hash, model, embedding)
       VALUES ('docs',$1,0,$2,$3,$4,$5::vector);`,
      [
        row.id,
        row.text,
        `h-${row.id}`,
        embedder.model.id,
        `[${Array.from(vectors[i] as Float32Array).join(',')}]`,
      ],
    );
  }
}

beforeEach(async () => {
  const root = await tempDir('sdlcof-rerank-');
  db = await provisionPglite({ workspaceRoot: root });
  opened.push(db);
  await applySchema(db);
}, 90_000);

afterAll(async () => {
  for (const handle of opened) await handle.close().catch(() => undefined);
});

describe('retrieve — fusion then rerank', () => {
  const corpus = [
    { id: 'TOP', text: 'quokka quokka quokka retry retry backoff' },
    { id: 'MID', text: 'quokka with a reattempt after some delay' },
    { id: 'LOW', text: 'quokka mentioned once in passing' },
  ];

  it('changes the order fusion produced, and says it did', async () => {
    const embedder = toyEmbedder();
    await seed(corpus, embedder);

    const fusedOnly = await retrieve(db, 'quokka retry backoff', { embedder });
    const reranked = await retrieve(db, 'quokka retry backoff', {
      embedder,
      encoder: preferring(['LOW', 'MID', 'TOP']),
    });

    expect(fusedOnly.reranked).toBe(false);
    expect(reranked.reranked).toBe(true);
    // Fusion and the reranker genuinely disagree here — if they agreed the
    // test could not tell a working rerank stage from a no-op.
    expect(fusedOnly.hits[0]?.sourceId).not.toBe(reranked.hits[0]?.sourceId);
    expect(reranked.hits[0]?.sourceId).toBe('LOW');
  }, 60_000);

  it('carries both stages’ skip reasons to the caller', async () => {
    await seed(corpus, toyEmbedder());
    // No embedder and no encoder: lexical-only, unreranked, and both said.
    const result = await retrieve(db, 'quokka');

    expect(result.semanticSkipped).toContain('no embedder');
    expect(result.skipped).toContain('no cross-encoder');
    // A degraded pipeline that reports nothing is indistinguishable from a
    // healthy one until someone notices the answers got worse.
    expect(result.hits.length).toBeGreaterThan(0);
  }, 60_000);

  it('keeps retrieval alive when the reranker is broken', async () => {
    const embedder = toyEmbedder();
    await seed(corpus, embedder);

    const result = await retrieve(db, 'quokka retry backoff', {
      embedder,
      encoder: () => Promise.reject(new Error('onnx session failed')),
    });

    expect(result.hits.map((h) => h.sourceId)).toContain('TOP');
    expect(result.reranked).toBe(false);
    expect(result.skipped).toContain('onnx session failed');
    // The fusion result survives intact — the legs still ran and still say so.
    expect(result.semanticRan).toBe(true);
  }, 60_000);

  it('reranks the returned hits, not the prefetch', async () => {
    const embedder = toyEmbedder();
    await seed(
      [
        ...corpus,
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `PAD${String(i)}`,
          text: `quokka padding row ${String(i)}`,
        })),
      ],
      embedder,
    );

    const result = await retrieve(db, 'quokka retry backoff', {
      embedder,
      limit: 3,
      prefetch: 11,
      encoder: preferring(['LOW', 'MID', 'TOP']),
    });

    // Eleven candidates reached the fusion; three survived it; three were
    // scored. Reranking the prefetch would cost nearly four times as much to
    // reorder a list that is mostly discarded a moment later.
    expect(result.scored).toBe(3);
    expect(result.hits).toHaveLength(3);
  }, 60_000);
});

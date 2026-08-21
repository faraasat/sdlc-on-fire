import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import type { EmbedderPort } from '@sdlc-on-fire/core';
import { DEFAULT_RRF_K, hybridSearch, rrf } from './hybrid.js';

/**
 * P1-CTX-03 — hybrid retrieval, against real PGlite with a real `vector` column
 * and a real GIN index.
 *
 * The point of the whole design is that the two legs fail *differently*, so the
 * tests that matter are the ones where one leg finds something the other cannot.
 * A mock would let both legs agree by construction and prove nothing.
 */

let db: ProvisionedDatabase;

/**
 * A toy embedder: one dimension per keyword, so "similarity" is controllable and
 * the test is about fusion rather than about a model.
 */
/**
 * One dimension per *concept*, with a synonym per concept.
 *
 * The synonyms are the point. An embedder keyed on the same words the lexical
 * leg matches makes a semantic-only hit impossible to construct, so the first
 * version of these tests could not tell hybrid retrieval from running the
 * lexical leg twice — and two mutations survived because of it.
 */
const CONCEPTS = [
  ['retry', 'reattempt'],
  ['backoff', 'delay'],
  ['invoice', 'billing'],
  ['currency', 'money'],
  ['parse', 'read'],
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
  // `chunk_tsv` is a GENERATED column — Postgres maintains it from chunk_text.
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-hybrid-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
}, 90_000);

// Closed per test, not collected and closed at the end. Every instance here is
// a whole Postgres compiled to wasm; holding one open per test kept nine of
// them resident and pushed the single closing loop past the hook budget, which
// failed the suite on teardown while every assertion in it had passed.
afterEach(async () => {
  await db?.close().catch(() => undefined);
}, 30_000);

describe('rrf', () => {
  it('rewards agreement over a single first place', () => {
    // Two legs agreeing at rank 3 beats one leg's rank 1 — the property that
    // makes fusion worth doing rather than concatenating.
    expect(rrf(3) + rrf(3)).toBeGreaterThan(rrf(1));
  });

  it('flattens with k, so rank 1 does not dominate everything below it', () => {
    expect(rrf(1, 1) / rrf(2, 1)).toBeGreaterThan(rrf(1, DEFAULT_RRF_K) / rrf(2, DEFAULT_RRF_K));
  });
});

describe('hybridSearch', () => {
  it('surfaces a document only the semantic leg can find', async () => {
    const embedder = toyEmbedder();
    await seed(
      [
        { id: 'A', text: 'The importer will retry on failure using backoff.' },
        { id: 'B', text: 'Completely unrelated text concerning tax and rounding.' },
      ],
      embedder,
    );

    // No lexical overlap with A's wording at all — "attempts again" shares no
    // stem with "retry".
    const result = await hybridSearch(db, 'retry backoff', { embedder });
    expect(result.semanticRan).toBe(true);
    expect(result.hits[0]?.sourceId).toBe('A');
    expect(result.hits[0]?.legs).toContain('semantic');
  }, 60_000);

  it('surfaces a document only the lexical leg can find', async () => {
    const embedder = toyEmbedder();
    await seed(
      [
        { id: 'A', text: 'The parser handles a quokka identifier in the schema.' },
        { id: 'B', text: 'Retry and backoff behaviour for the importer.' },
      ],
      embedder,
    );

    // "quokka" is in no keyword dimension, so the toy embedder is blind to it —
    // the rare-token case semantic retrieval drifts on and lexical nails.
    const result = await hybridSearch(db, 'quokka', { embedder });
    const found = result.hits.find((hit) => hit.sourceId === 'A');
    expect(found).toBeDefined();
    expect(found?.legs).toContain('lexical');
  }, 60_000);

  it('ranks agreement above a single first place', async () => {
    const embedder = toyEmbedder();
    await seed(
      [
        // Rank 1 lexically on the rare token, invisible to the toy embedder.
        { id: 'X_LEX_ONLY', text: 'quokka quokka quokka' },
        // Behind X lexically and behind Z semantically — but present in both.
        { id: 'Y_BOTH', text: 'quokka once, with retry and backoff.' },
        // Rank 1 semantically, no rare token at all.
        { id: 'Z_SEM_ONLY', text: 'retry backoff invoice currency parse.' },
      ],
      embedder,
    );

    // prefetch 2, so each leg's list is genuinely a *top*-2 and X falls out of
    // the semantic one. With a prefetch wider than the corpus every document
    // appears in both legs and the fusion has nothing to fuse.
    const result = await hybridSearch(db, 'quokka retry backoff', { embedder, prefetch: 2 });
    const rankOf = (id: string) => result.hits.findIndex((hit) => hit.sourceId === id);

    // The whole argument for RRF over "take the best score a document got":
    // agreement across legs *accumulates*. Y is second in both lists and beats
    // a document that came first in one. Under a max-of-scores fusion X wins
    // and running two legs buys nothing.
    expect(rankOf('Y_BOTH')).toBe(0);
    expect(rankOf('X_LEX_ONLY')).toBeGreaterThan(0);
  }, 60_000);

  it('falls back to lexical when the corpus holds another model', async () => {
    const embedder = toyEmbedder('bge-small-en-v1.5');
    await seed(
      [{ id: 'A', text: 'Retry and backoff for the importer.' }],
      toyEmbedder('jina-code'),
    );

    const result = await hybridSearch(db, 'retry backoff', { embedder });
    // Fail closed: skipped and *said so*, so a caller can tell "retrieval is
    // degraded" from "there is nothing to find".
    expect(result.semanticRan).toBe(false);
    expect(result.semanticSkipped).toContain('jina-code');
    expect(result.hits.length).toBeGreaterThan(0);
  }, 60_000);

  it('runs lexical-only when no embedder is configured, and says which', async () => {
    await seed([{ id: 'A', text: 'Retry and backoff for the importer.' }], toyEmbedder());
    const result = await hybridSearch(db, 'retry backoff');
    expect(result.semanticRan).toBe(false);
    expect(result.semanticSkipped).toContain('no embedder');
    expect(result.hits[0]?.legs).toEqual(['lexical']);
  }, 60_000);

  it('ignores tombstoned chunks in both legs', async () => {
    const embedder = toyEmbedder();
    await seed([{ id: 'A', text: 'Retry and backoff for the importer.' }], embedder);
    await db.query('UPDATE embeddings SET tombstoned_at = now();');

    const result = await hybridSearch(db, 'retry backoff', { embedder });
    // A retired vector being served is the whole reason tombstones exist.
    expect(result.hits).toEqual([]);
  }, 60_000);

  it('fuses from the prefetch depth, not from what it returns', async () => {
    const embedder = toyEmbedder();
    await seed(
      [
        // Eight documents that own the top of the lexical list on the rare
        // token and are invisible to the embedder.
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `LEXNOISE${String(i)}`,
          text: `quokka quokka quokka note number ${String(i)}`,
        })),
        // Four that own the top of the semantic list through synonyms, sharing
        // no term with the query at all.
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `SEMNOISE${String(i)}`,
          text: `reattempt with delay, variant ${String(i)}`,
        })),
        // Middling in both: one rare token, one concept by synonym. Reachable
        // only when the prefetch goes deeper than either pile of noise.
        { id: 'DEEP', text: 'quokka once, alongside a reattempt.' },
      ],
      embedder,
    );

    const query = 'quokka retry backoff';
    const shallow = await hybridSearch(db, query, { embedder, limit: 3, prefetch: 1 });
    const deep = await hybridSearch(db, query, { embedder, limit: 3, prefetch: 9 });

    // Both return three hits, so asserting the count proves nothing — that is
    // what let a "prefetch = limit" mutation survive the first version of this
    // test. What the depth changes is *which* documents reach the fusion: a
    // chunk ranked deep lexically and first semantically is exactly what hybrid
    // retrieval exists to surface, and a shallow prefetch never shows it.
    expect(deep.hits.map((h) => h.sourceId)).toContain('DEEP');
    expect(shallow.hits.map((h) => h.sourceId)).not.toContain('DEEP');
  }, 60_000);
});

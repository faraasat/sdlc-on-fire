import { describe, expect, it } from 'vitest';
import {
  cosine,
  planEmbedding,
  semanticLegUsable,
  type LiveChunk,
  type StoredVector,
} from './embedding.js';

/**
 * P1-CTX-04 — freshness and the model pin.
 *
 * The tests that matter are about the *silent* failure: a corpus holding two
 * embedding spaces returns confident nonsense and nothing errors. Everything
 * here exists to make that state either impossible or loudly closed.
 */

const chunk = (over: Partial<LiveChunk> = {}): LiveChunk => ({
  sourceTable: 'docs',
  sourceId: 'SPEC-1',
  index: 0,
  text: 'the importer retries',
  contentHash: 'h0',
  ...over,
});

const vector = (over: Partial<StoredVector> = {}): StoredVector => ({
  sourceTable: 'docs',
  sourceId: 'SPEC-1',
  index: 0,
  contentHash: 'h0',
  model: 'bge-small-en-v1.5',
  tombstoned: false,
  ...over,
});

describe('planEmbedding', () => {
  it('embeds a chunk with no vector', () => {
    const plan = planEmbedding([chunk()], [], 'bge-small-en-v1.5');
    expect(plan.embed).toHaveLength(1);
  });

  it('leaves an unchanged chunk alone', () => {
    const plan = planEmbedding([chunk()], [vector()], 'bge-small-en-v1.5');
    // The whole point of content-hash freshness: re-embedding what did not
    // change is the cost that kills the feature.
    expect(plan.embed).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('re-embeds a chunk whose text changed', () => {
    const plan = planEmbedding([chunk({ contentHash: 'h1' })], [vector()], 'bge-small-en-v1.5');
    expect(plan.embed).toHaveLength(1);
  });

  it('treats a different model as stale, exactly like different text', () => {
    const plan = planEmbedding([chunk()], [vector({ model: 'jina-code' })], 'bge-small-en-v1.5');
    // Comparing vectors across embedding spaces produces a number, and the
    // number means nothing — so an old-model vector is not reusable.
    expect(plan.embed).toHaveLength(1);
    expect(plan.mixedModel).toBe(true);
  });

  it('tombstones a vector whose chunk is gone, rather than deleting it', () => {
    const plan = planEmbedding([], [vector()], 'bge-small-en-v1.5');
    expect(plan.tombstone).toHaveLength(1);
  });

  it('revives a tombstoned vector when its chunk comes back unchanged', () => {
    const plan = planEmbedding([chunk()], [vector({ tombstoned: true })], 'bge-small-en-v1.5');
    // A file passing through an intermediate state during a sync would
    // otherwise cost a full re-embed on the way back.
    expect(plan.revive).toHaveLength(1);
    expect(plan.embed).toEqual([]);
  });

  it('re-embeds rather than revives when the text also changed', () => {
    const plan = planEmbedding(
      [chunk({ contentHash: 'h1' })],
      [vector({ tombstoned: true })],
      'bge-small-en-v1.5',
    );
    expect(plan.revive).toEqual([]);
    expect(plan.embed).toHaveLength(1);
  });

  it('does not tombstone something already tombstoned', () => {
    const plan = planEmbedding([], [vector({ tombstoned: true })], 'bge-small-en-v1.5');
    expect(plan.tombstone).toEqual([]);
  });

  it('keys on the chunk, not the document', () => {
    const plan = planEmbedding(
      [chunk({ index: 0 }), chunk({ index: 1, contentHash: 'h1' })],
      [vector({ index: 0 })],
      'bge-small-en-v1.5',
    );
    // A one-line edit to a large document must not re-embed the document.
    expect(plan.unchanged).toBe(1);
    expect(plan.embed).toHaveLength(1);
  });

  it('does not report a mixed model from tombstoned rows alone', () => {
    const plan = planEmbedding(
      [chunk()],
      [vector(), vector({ index: 9, model: 'jina-code', tombstoned: true })],
      'bge-small-en-v1.5',
    );
    // A retired vector from an old model is not being served, so it does not
    // make the corpus mixed — treating it as such would keep the semantic leg
    // closed forever after any model swap.
    expect(plan.mixedModel).toBe(false);
  });
});

describe('semanticLegUsable — fail closed (contracts/05 §5.2)', () => {
  it('is usable when the corpus and the config agree', () => {
    expect(
      semanticLegUsable({
        configuredModel: 'bge-small-en-v1.5',
        corpusModels: ['bge-small-en-v1.5'],
        vectorsPresent: 10,
      }),
    ).toEqual({ usable: true });
  });

  it('closes when the corpus holds another model', () => {
    const decision = semanticLegUsable({
      configuredModel: 'bge-small-en-v1.5',
      corpusModels: ['bge-small-en-v1.5', 'jina-code'],
      vectorsPresent: 10,
    });
    // Skipped, not queried-with-a-caveat: a caller cannot act on a caveat, and
    // a mixed-space result is meaningless rather than merely degraded.
    expect(decision.usable).toBe(false);
    if (decision.usable) return;
    expect(decision.reason).toContain('jina-code');
  });

  it('closes when nothing has been embedded yet', () => {
    expect(
      semanticLegUsable({
        configuredModel: 'bge-small-en-v1.5',
        corpusModels: [],
        vectorsPresent: 0,
      }).usable,
    ).toBe(false);
  });
});

describe('cosine', () => {
  it('is 1 for a vector with itself', () => {
    const v = Float32Array.from([0.6, 0.8]);
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  it('refuses to compare vectors of different widths', () => {
    // The mixed-embedding-space bug, caught at the comparison rather than
    // returned as a plausible-looking score.
    expect(() => cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow(
      /mixed-embedding-space/,
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createOnnxReranker, type RerankSessionFactory } from './reranker.js';

/**
 * P1-CTX-09 — the ONNX cross-encoder adapter.
 *
 * The session is injected, so these tests never download a reranker. What they
 * hold is the part a real model cannot be trusted to enforce: that the adapter
 * loads once, batches without losing alignment, and refuses a score list that
 * does not line up with its pairs.
 */

const stubSession = (
  score: (query: string, doc: string) => number,
): { factory: RerankSessionFactory; loads: () => number; calls: () => number } => {
  let loads = 0;
  let calls = 0;
  const factory: RerankSessionFactory = (_model, _dtype) => {
    loads += 1;
    return Promise.resolve({
      score: (query, documents) => {
        calls += 1;
        return Promise.resolve(documents.map((doc) => score(query, doc)));
      },
    });
  };
  return { factory, loads: () => loads, calls: () => calls };
};

describe('createOnnxReranker', () => {
  it('scores each document against the query', async () => {
    const stub = stubSession((query, doc) => (doc.includes(query) ? 1 : 0));
    const encoder = createOnnxReranker({ createSession: stub.factory });

    expect(await encoder('retry', ['nothing here', 'the importer will retry'])).toEqual([0, 1]);
  });

  it('loads the model once, even for two concurrent first queries', async () => {
    const stub = stubSession(() => 0.5);
    const encoder = createOnnxReranker({ createSession: stub.factory });

    await Promise.all([encoder('q', ['a']), encoder('q', ['b'])]);
    await encoder('q', ['c']);

    // Caching the result rather than the promise would let two concurrent
    // first calls each start the same download.
    expect(stub.loads()).toBe(1);
  });

  it('does not load the model at all for an empty candidate list', async () => {
    const stub = stubSession(() => 1);
    const encoder = createOnnxReranker({ createSession: stub.factory });

    expect(await encoder('q', [])).toEqual([]);
    // A query that retrieved nothing must not pay a model download.
    expect(stub.loads()).toBe(0);
  });

  it('batches without losing the document order', async () => {
    // Score = the document's own index, so any reordering across batch
    // boundaries shows up as a permutation rather than as a plausible list.
    const stub = stubSession((_q, doc) => Number(doc));
    const encoder = createOnnxReranker({ createSession: stub.factory, batchSize: 3 });

    const docs = Array.from({ length: 7 }, (_, i) => String(i));
    expect(await encoder('q', docs)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(stub.calls()).toBe(3);
  });

  it('throws when the session returns a score list of the wrong length', async () => {
    const factory: RerankSessionFactory = () =>
      Promise.resolve({
        score: (_query, documents) => Promise.resolve(documents.slice(1).map(() => 0.5)),
      });
    const encoder = createOnnxReranker({ createSession: factory });

    // Pairing is positional. A short list ranks every document by the next
    // document's relevance — output that looks fine and is wrong, which
    // `rerank()` can only turn into a fallback if it is thrown here.
    await expect(encoder('q', ['a', 'b'])).rejects.toThrow(/1 scores for 2 pairs/);
  });

  it('passes the configured model id and precision through to the runtime', async () => {
    const factory = vi.fn<RerankSessionFactory>(() =>
      Promise.resolve({ score: (_q, docs) => Promise.resolve(docs.map(() => 1)) }),
    );
    const encoder = createOnnxReranker({ createSession: factory, modelId: 'Xenova/other' });
    await encoder('q', ['a']);

    // fp32 unless asked otherwise: it is the arm that was actually measured.
    expect(factory).toHaveBeenCalledWith('Xenova/other', 'fp32');
  });

  it('lowers precision only when a caller asks', async () => {
    const factory = vi.fn<RerankSessionFactory>(() =>
      Promise.resolve({ score: (_q, docs) => Promise.resolve(docs.map(() => 1)) }),
    );
    await createOnnxReranker({ createSession: factory, dtype: 'q8' })('q', ['a']);

    expect(factory).toHaveBeenCalledWith(expect.any(String), 'q8');
  });
});

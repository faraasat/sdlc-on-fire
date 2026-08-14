import { describe, expect, it } from 'vitest';
import { createOnnxEmbedder, type PipelineFactory } from './onnx.js';

/**
 * P1-CTX-04 — the adapter.
 *
 * The pipeline is injected so a unit test never downloads 126 MB. The *real*
 * runtime is exercised separately against PGlite in
 * `worker.integration.test.ts`; a suite that only ever ran a stub would be
 * testing the stub.
 */

/** A pipeline that returns unit vectors of the requested width. */
const fakePipeline =
  (dim: number, onCall?: () => void): PipelineFactory =>
  () => {
    onCall?.();
    return Promise.resolve((texts) => {
      const data = new Float32Array(texts.length * dim);
      for (let r = 0; r < texts.length; r += 1) data[r * dim] = 1;
      return Promise.resolve({ data, dims: [texts.length, dim] });
    });
  };

describe('createOnnxEmbedder', () => {
  it('returns one vector per text, at the configured width', async () => {
    const embedder = createOnnxEmbedder({ createPipeline: fakePipeline(384) });
    const out = await embedder.embed(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(out[0]).toHaveLength(384);
  });

  it('loads the model once across calls, and once across concurrent first calls', async () => {
    let loads = 0;
    const embedder = createOnnxEmbedder({
      createPipeline: fakePipeline(384, () => {
        loads += 1;
      }),
    });
    // Cached on the promise, not the result: two concurrent first calls would
    // otherwise each start a download of the same model.
    await Promise.all([embedder.embed(['a']), embedder.embed(['b'])]);
    await embedder.embed(['c']);
    expect(loads).toBe(1);
  });

  it('does not load the model for an empty batch', async () => {
    let loads = 0;
    const embedder = createOnnxEmbedder({
      createPipeline: fakePipeline(384, () => {
        loads += 1;
      }),
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(loads).toBe(0);
  });

  it('refuses a model whose width does not match the configured one', async () => {
    const embedder = createOnnxEmbedder({ createPipeline: fakePipeline(768) });
    // Caught here rather than at insert: the column would reject it with a
    // message about SQL rather than about the model.
    await expect(embedder.embed(['a'])).rejects.toThrow(/migration and a full re-embed/);
  });

  it('splits a batch without dropping or duplicating anything', async () => {
    const embedder = createOnnxEmbedder({ createPipeline: fakePipeline(384), batchSize: 2 });
    const out = await embedder.embed(['a', 'b', 'c', 'd', 'e']);
    expect(out).toHaveLength(5);
    for (const v of out) expect(v).toHaveLength(384);
  });

  it('records the model id that will be written to every row', () => {
    const embedder = createOnnxEmbedder({ createPipeline: fakePipeline(384) });
    // The pin is what stops a corpus mixing embedding spaces, so it has to be
    // the thing rows are stamped with — not the transformers.js repo path.
    expect(embedder.model.id).toBe('bge-small-en-v1.5');
    expect(embedder.model.dimensions).toBe(384);
  });
});

import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  type EmbedderPort,
  type EmbeddingModel,
} from '@sdlc-on-fire/core';

/**
 * The local ONNX embedder (P1-CTX-04, ADR-0004).
 *
 * **Why `@huggingface/transformers` and not `fastembed`**, which the task text
 * names: both wrap `onnxruntime-node`, so the runtime is the same either way.
 * What differs is what is known about them. The A-03 eval ran three models
 * through transformers.js in this environment, so it is known to work here —
 * whereas `fastembed`'s tokenizer is a single-maintainer native binding
 * (`@anush008/tokenizers`), last published eight months ago, and the *task's own
 * risk note* is "native-binary portability". Choosing the one with evidence over
 * the one that was written down is the same discipline as the rest of this
 * repo. It is also cheap to reverse: this is an adapter behind `EmbedderPort`.
 *
 * The model is **loaded lazily and once**. A 126 MB download on first use is a
 * surprise; a 126 MB download on every call is a bug.
 */

/** Injected in tests so a unit test never downloads 126 MB. */
export type PipelineFactory = (
  model: string,
) => Promise<
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ) => Promise<{ data: Float32Array | number[]; dims: readonly number[] }>
>;

export interface OnnxEmbedderOptions {
  /** Model id as transformers.js resolves it. Defaults to the ONNX-published bge-small. */
  readonly modelId?: string | undefined;
  /** The id recorded on every row. Defaults to the contract's short name. */
  readonly modelName?: string | undefined;
  readonly dimensions?: number | undefined;
  /** Chunks per forward pass. Larger is faster and costs proportionally more memory. */
  readonly batchSize?: number | undefined;
  readonly createPipeline?: PipelineFactory | undefined;
}

const DEFAULT_MODEL_ID = 'Xenova/bge-small-en-v1.5';

/**
 * Creates the embedder.
 *
 * Returns a port, not a class, so nothing downstream can reach past the
 * interface into the runtime — which is what would make swapping the model
 * expensive later.
 */
export function createOnnxEmbedder(options: OnnxEmbedderOptions = {}): EmbedderPort {
  const model: EmbeddingModel = {
    id: options.modelName ?? DEFAULT_EMBEDDING_MODEL,
    dimensions: options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
  };
  const batchSize = options.batchSize ?? 16;
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;

  let pipelinePromise: ReturnType<PipelineFactory> | undefined;
  const load = async (): Promise<Awaited<ReturnType<PipelineFactory>>> => {
    // Cached on the promise, not the result: two concurrent first calls would
    // otherwise each start a download of the same model.
    pipelinePromise ??= (options.createPipeline ?? defaultPipeline)(modelId);
    return await pipelinePromise;
  };

  return {
    model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const extract = await load();
      const out: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        // Mean pooling + L2 normalisation: what bge-small is trained for, and
        // what makes a dot product a cosine.
        const tensor = await extract([...batch], { pooling: 'mean', normalize: true });
        const dim = tensor.dims[tensor.dims.length - 1] ?? model.dimensions;

        if (dim !== model.dimensions) {
          // Caught here rather than at insert: a vector of the wrong width is
          // the mixed-embedding-space bug arriving early, and the column would
          // reject it with a message about SQL rather than about the model.
          throw new Error(
            `${modelId} produced ${String(dim)}-dim vectors but this workspace is configured ` +
              `for ${String(model.dimensions)} — a model swap needs a migration and a full re-embed`,
          );
        }

        const data =
          tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(tensor.data);
        for (let r = 0; r < batch.length; r += 1) {
          out.push(data.slice(r * dim, (r + 1) * dim));
        }
      }
      return out;
    },
  };
}

/**
 * The real transformers.js pipeline, imported lazily.
 *
 * A static import would pull `onnxruntime-node` into every process that touches
 * the daemon, including the CLI paths that never embed anything — a multi-second
 * startup cost paid by commands that do no inference.
 */
const defaultPipeline: PipelineFactory = async (modelId) => {
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', modelId, { dtype: 'fp32' });
  return async (texts, opts) => {
    const tensor = await extractor(texts, opts);
    return { data: tensor.data as Float32Array, dims: tensor.dims };
  };
};

import type { CrossEncoder } from '@sdlc-on-fire/context';

/**
 * The local ONNX cross-encoder (P1-CTX-09, FEAT-CTX-023).
 *
 * Same runtime as the embedder — `@huggingface/transformers` over
 * `onnxruntime-node` — and the same reasons ([onnx.ts](./onnx.ts)). What differs
 * is the task: a cross-encoder reads the query and the document *together*, so
 * there is no vector to cache and every score is a forward pass at query time.
 * That is why the stage is optional and why it is bounded by `topK` rather than
 * run over the whole prefetch.
 *
 * **Not the `text-classification` pipeline**, which is the obvious-looking
 * choice and is wrong twice. Its `_call` tokenizes `texts` alone — there is no
 * `text_pair` argument, so the document would be scored without the query ever
 * being seen — and it softmaxes the logits, which over a reranker's single
 * output class returns 1.0 for every document. Both failures produce a
 * well-formed list of scores that ranks nothing. The tokenizer *does* take
 * `text_pair`, so the model is driven directly, which is also what the
 * cross-encoder cards document.
 *
 * **Second model, second decision, and an expensive one.** `Xenova/bge-reranker-base`
 * at fp32 is **1.1 GB on disk** — measured, not quoted — against the embedder's
 * 126 MB. That is nine times the embedder for a stage that only reorders what
 * fusion already found, which is the strongest argument for the whole thing
 * being opt-in: a workspace that has not asked for it should never pay that
 * download, and nothing here is constructed unless a caller asks.
 *
 * `dtype` is exposed for that reason. Quantizing is the obvious lever on the
 * 1.1 GB and it is **unmeasured** — no q8 arm has been run on our corpus, so
 * fp32 stays the default rather than a smaller number nobody has checked. The
 * A-03 harness is the thing that would justify changing it.
 */

/** One loaded cross-encoder. Injected in tests so a unit test downloads nothing. */
export interface RerankSession {
  /** Scores each document against the query, positionally. Higher is more relevant. */
  score: (query: string, documents: readonly string[]) => Promise<readonly number[]>;
}

export type RerankSessionFactory = (
  model: string,
  dtype: NonNullable<OnnxRerankerOptions['dtype']>,
) => Promise<RerankSession>;

export interface OnnxRerankerOptions {
  /** Model id as transformers.js resolves it. */
  readonly modelId?: string | undefined;
  /** Pairs per forward pass. Larger is faster and costs proportionally more memory. */
  readonly batchSize?: number | undefined;
  /** ONNX weight precision. `fp32` is the measured one; see above before lowering it. */
  readonly dtype?: 'fp32' | 'fp16' | 'q8' | undefined;
  readonly createSession?: RerankSessionFactory | undefined;
}

const DEFAULT_RERANKER_ID = 'Xenova/bge-reranker-base';

/**
 * Creates the cross-encoder.
 *
 * Returns the bare `CrossEncoder` function the context package expects, so the
 * retrieval pipeline never learns that ONNX exists — the same port discipline
 * the embedder follows, and what makes "swap the reranker" a one-file change.
 */
export function createOnnxReranker(options: OnnxRerankerOptions = {}): CrossEncoder {
  const modelId = options.modelId ?? DEFAULT_RERANKER_ID;
  const batchSize = options.batchSize ?? 8;
  const dtype = options.dtype ?? 'fp32';

  let sessionPromise: Promise<RerankSession> | undefined;
  const load = async (): Promise<RerankSession> => {
    // Cached on the promise, not the result — two concurrent first queries would
    // otherwise each start the same download.
    sessionPromise ??= (options.createSession ?? defaultRerankSession)(modelId, dtype);
    return await sessionPromise;
  };

  return async (query, documents) => {
    if (documents.length === 0) return [];
    const session = await load();
    const scores: number[] = [];

    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const batchScores = await session.score(query, batch);

      if (batchScores.length !== batch.length) {
        // The contract is positional. A short or long score list would silently
        // shift every score onto the wrong document, which reorders results
        // plausibly and undetectably — so it is an error, and `rerank()` turns
        // it into a fallback to the fused order.
        throw new Error(
          `${modelId} returned ${String(batchScores.length)} scores for ${String(batch.length)} pairs — ` +
            'pairing them would rank each document by another document’s relevance',
        );
      }
      scores.push(...batchScores);
    }
    return scores;
  };
}

/**
 * The real transformers.js cross-encoder, imported lazily — a static import
 * would pull `onnxruntime-node` into processes that never rerank anything.
 */
const defaultRerankSession: RerankSessionFactory = async (modelId, dtype) => {
  const { AutoTokenizer, AutoModelForSequenceClassification } =
    await import('@huggingface/transformers');
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await AutoModelForSequenceClassification.from_pretrained(modelId, { dtype });

  return {
    score: async (query, documents) => {
      const inputs = tokenizer(
        // The query is repeated so the tokenizer pairs each document with it —
        // `text` and `text_pair` must be arrays of the same length.
        Array.from({ length: documents.length }, () => query),
        { text_pair: [...documents], padding: true, truncation: true },
      );
      // `AutoModel`'s call signature is untyped, so the output shape is asserted
      // once, here at the boundary, rather than leaking `any` upward.
      const { logits } = (await model(inputs)) as {
        logits: { sigmoid: () => { tolist: () => number[][] } };
      };
      // Sigmoid rather than softmax: the head has one output, so softmax would
      // return 1.0 for every document. Sigmoid is monotonic, so it does not
      // change the ranking — it only puts the score in [0, 1] for reporting.
      return logits
        .sigmoid()
        .tolist()
        .map((row) => row[0] ?? 0);
    },
  };
};

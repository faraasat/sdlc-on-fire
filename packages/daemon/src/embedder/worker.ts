import {
  planEmbedding,
  type EmbedderPort,
  type EmbeddingPlan,
  type LiveChunk,
  type StoredVector,
} from '@sdlc-on-fire/core';

/**
 * The embeddings worker (P1-CTX-04).
 *
 * Reconciles what the corpus holds against what the content now says, and spends
 * inference only on the difference. The planning is core's and pure; what is
 * here is the part that touches a database and a model.
 *
 * **A model swap is atomic, and that is the whole reason this is a worker rather
 * than an insert.** Half a corpus in the new embedding space and half in the old
 * is not a degraded index — it is one that returns confident nonsense, because
 * cosine distance across two spaces is a number with no meaning. So a swap
 * writes new vectors alongside the old and flips which model is active only when
 * every chunk has one, and the semantic leg stays closed until then
 * (contracts/05 §5.2).
 */

export interface VectorStore {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}

export interface EmbedRunResult {
  readonly plan: EmbeddingPlan;
  readonly embedded: number;
  readonly tombstoned: number;
  readonly revived: number;
  /** Whether the semantic leg may serve queries after this run. */
  readonly semanticReady: boolean;
  readonly reason: string;
}

/** Every vector currently in the corpus, for the freshness comparison. */
export async function storedVectors(db: VectorStore): Promise<readonly StoredVector[]> {
  const rows = await db.query<{
    source_table: string;
    source_id: string;
    chunk_index: number;
    content_hash: string;
    model: string;
    tombstoned_at: Date | string | null;
  }>(
    `SELECT source_table, source_id, chunk_index, content_hash, model, tombstoned_at
       FROM embeddings;`,
  );
  return rows.map((row) => ({
    sourceTable: row.source_table,
    sourceId: row.source_id,
    index: Number(row.chunk_index),
    contentHash: row.content_hash,
    model: row.model,
    tombstoned: row.tombstoned_at !== null,
  }));
}

/** pgvector's literal form. Built here so no caller hand-formats a vector. */
function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(',')}]`;
}

/**
 * Brings the corpus up to date.
 *
 * Order matters: tombstone first, then revive, then embed. Embedding first would
 * mean a crash between the two leaves new vectors alongside stale ones that
 * should have been retired — and the stale ones would still be served.
 */
export async function runEmbedding(
  db: VectorStore,
  embedder: EmbedderPort,
  live: readonly LiveChunk[],
): Promise<EmbedRunResult> {
  const stored = await storedVectors(db);
  const plan = planEmbedding(live, stored, embedder.model.id);

  for (const dead of plan.tombstone) {
    // Soft-delete. A vector whose source vanished may be a real deletion or a
    // file mid-move during a sync; deleting on the second loses work a revive
    // recovers for free.
    await db.query(
      `UPDATE embeddings SET tombstoned_at = now()
        WHERE source_table = $1 AND source_id = $2 AND chunk_index = $3;`,
      [dead.sourceTable, dead.sourceId, dead.index],
    );
  }

  for (const back of plan.revive) {
    await db.query(
      `UPDATE embeddings SET tombstoned_at = NULL
        WHERE source_table = $1 AND source_id = $2 AND chunk_index = $3;`,
      [back.sourceTable, back.sourceId, back.index],
    );
  }

  if (plan.embed.length > 0) {
    const vectors = await embedder.embed(plan.embed.map((chunk) => chunk.text));
    if (vectors.length !== plan.embed.length) {
      throw new Error(
        `embedder returned ${String(vectors.length)} vectors for ${String(plan.embed.length)} chunks — ` +
          'writing them would pair vectors with the wrong text, which is undetectable afterwards',
      );
    }
    for (const [i, chunk] of plan.embed.entries()) {
      await db.query(
        `INSERT INTO embeddings
           (source_table, source_id, chunk_index, chunk_text, content_hash, model, embedding, tombstoned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector,NULL)
         ON CONFLICT (source_table, source_id, chunk_index)
         DO UPDATE SET chunk_text = EXCLUDED.chunk_text,
                       content_hash = EXCLUDED.content_hash,
                       model = EXCLUDED.model,
                       embedding = EXCLUDED.embedding,
                       tombstoned_at = NULL;`,
        [
          chunk.sourceTable,
          chunk.sourceId,
          chunk.index,
          chunk.text,
          chunk.contentHash,
          embedder.model.id,
          toVectorLiteral(vectors[i] as Float32Array),
        ],
      );
    }
  }

  // Re-read rather than reasoning from the plan. The plan said what *should*
  // happen; this says what is there — and the semantic leg's safety turns on
  // the second.
  const after = await storedVectors(db);
  const live_ = after.filter((v) => !v.tombstoned);
  const foreign = [...new Set(live_.map((v) => v.model))].filter((m) => m !== embedder.model.id);

  return {
    plan,
    embedded: plan.embed.length,
    tombstoned: plan.tombstone.length,
    revived: plan.revive.length,
    semanticReady: live_.length > 0 && foreign.length === 0,
    reason:
      live_.length === 0
        ? 'no live vectors'
        : foreign.length > 0
          ? `corpus still holds vectors from ${foreign.join(', ')} — semantic leg stays closed`
          : `${String(live_.length)} vectors, all from ${embedder.model.id}`,
  };
}

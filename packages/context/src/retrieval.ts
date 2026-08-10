import type { StoragePort } from '@sdlc-on-fire/core';
import type { RetrievedChunk, Retriever } from './assemble.js';

/**
 * v0.1 retrieval: Postgres full-text search only.
 *
 * The mvp-slice defers pgvector and embeddings to v0.2 specifically so the
 * walking skeleton does not depend on the unproven embedding-quality assumption
 * (A-03). `tsvector` still beats naive grep, and the seam here is the same one
 * hybrid retrieval plugs into later.
 */

/**
 * Retrieval reaches chunks through the {@link StoragePort} (ADR-0047).
 *
 * Narrowed to the one method it uses, so a caller can hand over anything that
 * can search — and so this module never learns that Postgres exists.
 */
export type RetrievalStore = Pick<StoragePort, 'searchChunks'>;

/**
 * Turns free text into a `websearch_to_tsquery` input.
 *
 * Uses `websearch_to_tsquery` rather than `to_tsquery` because the latter throws
 * on unescaped punctuation — and the query here is a work item's own prose,
 * which is full of it.
 */
export function toSearchQuery(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 40)
    .join(' ');
}

const CHUNK_CHARS = 1_200;

/**
 * Full-text retriever over chunked document **content**.
 *
 * Searches chunked body text rather than titles. Retrieving titles would make a
 * pack technically "narrower than a full-file dump" while carrying no content at
 * all — the letter of the mvp-slice DoD and not its point (P0-SPIKE-02, D3).
 *
 * Ranking and index strategy belong to the adapter; this module only asks for
 * the top `limit` chunks and adapts them to the pack's shape.
 */
export function createTsvectorRetriever(store: RetrievalStore): Retriever {
  return async (query: string, limit: number): Promise<RetrievedChunk[]> => {
    const search = toSearchQuery(query);
    if (search.length === 0) return [];

    const hits = await store.searchChunks(search, limit);

    return hits.map((hit) => ({
      id: `${hit.sourceId}#${String(hit.index)}`,
      text: hit.text,
      score: hit.score,
      tokens: Math.ceil(hit.text.length / 4),
    }));
  };
}

/**
 * Splits text into chunks on paragraph boundaries.
 *
 * Splitting mid-sentence produces chunks that retrieve well and read terribly;
 * a paragraph is the smallest unit that still makes sense out of context.
 * Heading-aware chunking with breadcrumbs is `P1-CTX-02`.
 */
export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim().length > 0);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

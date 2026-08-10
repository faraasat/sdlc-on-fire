import type { RetrievedChunk, Retriever } from './assemble.js';

/**
 * v0.1 retrieval: Postgres full-text search only.
 *
 * The mvp-slice defers pgvector and embeddings to v0.2 specifically so the
 * walking skeleton does not depend on the unproven embedding-quality assumption
 * (A-03). `tsvector` still beats naive grep, and the seam here is the same one
 * hybrid retrieval plugs into later.
 */

export interface RetrievalStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

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
 * Full-text retriever over the doc mirror.
 *
 * Ranks with `ts_rank_cd`, which accounts for term proximity — a doc mentioning
 * both query terms in one paragraph outranks one mentioning them chapters apart.
 */
export function createTsvectorRetriever(store: RetrievalStore): Retriever {
  return async (query: string, limit: number): Promise<RetrievedChunk[]> => {
    const search = toSearchQuery(query);
    if (search.length === 0) return [];

    const rows = await store.query<{ id: string; title: string | null; rank: number }>(
      `SELECT id, title,
              ts_rank_cd(to_tsvector('english', coalesce(title, '')),
                         websearch_to_tsquery('english', $1)) AS rank
         FROM docs
        WHERE to_tsvector('english', coalesce(title, '')) @@ websearch_to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2;`,
      [search, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      text: row.title ?? row.id,
      score: Number(row.rank),
      tokens: Math.ceil((row.title ?? row.id).length / 4),
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

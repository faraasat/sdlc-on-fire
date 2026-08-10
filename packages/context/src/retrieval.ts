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

/** Terms kept from a query. Beyond this, ranking is unaffected and parsing is not free. */
const MAX_QUERY_TERMS = 40;

/**
 * Turns free text into a `to_tsquery` **OR** expression.
 *
 * This used to emit a bare word list for `websearch_to_tsquery`, and that is a
 * defect the A-03 embedding eval found: `websearch_to_tsquery` joins terms with
 * **AND**, so a 40-term query demanded all forty stems be present in one chunk.
 * The real caller is `assembleContextPack`, which passes the *entire card body*
 * as the query — so retrieval returned **zero rows for every realistic query**,
 * while every test passed, because every test searched for a single invented
 * word (`pangolins`, `narwhals`). Retrieval "beat naive grep" only on inputs no
 * user would type.
 *
 * OR is what a ranked retriever wants: match anything, and let `ts_rank_cd`
 * order by how much matched and how close together it is. AND is a filter, and
 * a filter over free prose is a filter that rejects everything.
 *
 * `to_tsquery` is safe here specifically *because* the sanitiser leaves only
 * letters, digits and the ` | ` we insert — the punctuation objection that
 * motivated `websearch_to_tsquery` is handled by stripping, not by the parser.
 * Postgres drops stopwords itself, and an all-stopword query yields an empty
 * tsquery that matches nothing, which is the correct answer rather than a throw.
 */
export function toSearchQuery(text: string): string {
  const terms = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  // Deduped: a term repeated in the prose is not twice as relevant, and
  // `to_tsquery` would carry the duplicate into the parsed query.
  return [...new Set(terms.map((term) => term.toLowerCase()))]
    .slice(0, MAX_QUERY_TERMS)
    .join(' | ');
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

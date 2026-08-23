import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  evaluateRetrieval,
  RelevanceSetSchema,
  resolveWorkspaceLayout,
  scoreQuery,
  type RelevanceSet,
  type RetrievalEvaluation,
} from '@sdlc-on-fire/core';
import { hybridSearch } from '@sdlc-on-fire/context';
import YAML from 'yaml';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc metrics retrieval` (P6-INSTRUMENT-01, FEAT-MET-012).
 *
 * Runs the **real** retriever over a human-judged relevance set. Not a fixture
 * and not a mock: the whole point is to measure the pipeline that actually runs,
 * including whatever the RRF constant is set to today.
 *
 * The relevance set is **content, under `docs/`**, for the same reason gate
 * policies are (contract 06 §"docs/gates/"): it is hand-edited, diffed and
 * argued about in review, so it cannot live under the gitignored state
 * directory. It must survive `db:rebuild` — a relevance set the rebuild wipes is
 * one nobody can compare across runs, which is the only thing it is for.
 */

export const RELEVANCE_PATH = path.join('docs', 'retrieval', 'relevance.yaml');

export class MissingRelevanceSet extends Error {
  override readonly name = 'MissingRelevanceSet';
  constructor(where: string) {
    super(
      `no relevance set at ${where}. Retrieval quality cannot be measured without human judgements — ` +
        'create the file with `held_out: true` and at least one judgement naming the chunk ids that answer a query.',
    );
  }
}

export async function loadRelevanceSet(root: string): Promise<RelevanceSet> {
  const layout = resolveWorkspaceLayout(root);
  const where = path.join(layout.root, RELEVANCE_PATH);
  const raw = await fs.readFile(where, 'utf8').catch(() => null);
  // Refused, not defaulted to empty. An empty set scores every retriever
  // identically and reports it as a measurement, which is worse than reporting
  // nothing at all.
  if (raw === null) throw new MissingRelevanceSet(RELEVANCE_PATH);
  return RelevanceSetSchema.parse(YAML.parse(raw));
}

export interface RetrievalEvalResult extends RetrievalEvaluation {
  readonly source: string;
  readonly judgedBy: readonly string[];
}

export async function retrievalReport(root: string, k = 10): Promise<RetrievalEvalResult> {
  const set = await loadRelevanceSet(root);
  const { db } = await openWorkspaceDatabase(root);
  try {
    const scores = [];
    for (const judgement of set.judgements) {
      // Lexical-only unless an embedder is configured. Deliberately not a
      // silent fallback: `hybridSearch` reports which legs ran, and a score
      // measured with the semantic leg off is a different number from one
      // measured with it on. The report says which it was.
      const result = await hybridSearch(db, judgement.query, { limit: k });
      scores.push(
        scoreQuery(
          judgement,
          result.hits.map((hit) => hit.id),
          k,
        ),
      );
    }

    return {
      ...evaluateRetrieval(scores, k),
      source: RELEVANCE_PATH,
      judgedBy: [...new Set(set.judgements.map((judgement) => judgement.judged_by))].sort(),
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

export function formatRetrieval(report: RetrievalEvalResult): string {
  const pct = (value: number | null): string =>
    value === null ? 'not available' : `${(value * 100).toFixed(1)}%`;

  const lines = [
    `precision@${String(report.k)} over ${String(report.queries.length)} judged quer(y/ies) from ${report.source}`,
    `judged by: ${report.judgedBy.join(', ')}`,
    '',
    `  mean precision:  ${pct(report.meanPrecision)}`,
    // Printed directly beneath precision, because on a small corpus the raw
    // precision is capped by how many chunks are relevant at all, and reading it
    // alone makes a retriever that did everything possible look like a failure.
    `  of what was achievable: ${pct(report.meanOfCeiling)}`,
    `  mean recall:     ${pct(report.meanRecall)}`,
  ];

  if (report.blind.length > 0) {
    lines.push('', 'returned nothing relevant at all:');
    for (const query of report.blind) lines.push(`  ${query}`);
  }

  lines.push('', 'per query:');
  for (const score of report.queries) {
    lines.push(
      `  ${score.hits}/${String(Math.min(score.relevant, score.k))} possible — ${score.query}` +
        (score.missed.length > 0 ? `\n    missed: ${score.missed.join(', ')}` : ''),
    );
  }
  return lines.join('\n');
}

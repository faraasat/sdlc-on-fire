import fs from 'node:fs/promises';
import path from 'node:path';
import {
  analyseVisibility,
  citedSources,
  corpusCoverage,
  matrixSize,
  validateMatrix,
  type ResponseCorpus,
  type Rate,
} from '@sdlc-on-fire/core';
import {
  formatVisibilityTrend,
  resolveWorkspaceLayout,
  visibilityTrend,
  wilson,
  type VisibilityTrend,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc visibility` — reading a recorded corpus (P5-VIZ-02/03, ADR-0074).
 *
 * **This command makes no network calls and cannot.** It reads a corpus that a
 * run produced and reports what is in it. Querying engines costs money against
 * somebody's API key, so it is opt-in, off by default, and deliberately not
 * wired to this command — the analysis half is the half worth having in the
 * product, and it is the half that can be tested.
 *
 * If no corpus exists, that is what it says. An instrument reporting zeros
 * because it has no data looks exactly like one reporting zeros because nobody
 * mentions you, and those are opposite facts.
 */

export const CORPUS_FILE = 'visibility-corpus.json';

export interface VisibilityResult {
  readonly corpusPath: string;
  readonly found: boolean;
  readonly coverage?: ReturnType<typeof corpusCoverage>;
  readonly analysis?: ReturnType<typeof analyseVisibility>;
  readonly sources?: ReturnType<typeof citedSources>;
  readonly problems: readonly string[];
}

export async function readVisibility(
  root: string,
  subject: string,
  host: string,
): Promise<VisibilityResult> {
  const layout = resolveWorkspaceLayout(root);
  const corpusPath = path.join(layout.stateDir, CORPUS_FILE);
  const raw = await fs.readFile(corpusPath, 'utf8').catch(() => null);

  if (raw === null) {
    return { corpusPath: CORPUS_FILE, found: false, problems: [] };
  }

  let corpus: ResponseCorpus;
  try {
    corpus = JSON.parse(raw) as ResponseCorpus;
  } catch (cause) {
    return {
      corpusPath: CORPUS_FILE,
      found: true,
      problems: [`corpus is not readable JSON: ${String(cause).split('\n')[0] ?? ''}`],
    };
  }

  // The matrix is validated from the artifact, not from whoever ran it. A
  // corpus produced by a design that could not support its own claim is still
  // a corpus, and saying so is the only way anybody finds out.
  const problems = validateMatrix(corpus.spec).map(
    (problem) => `matrix.${problem.field}: ${problem.because}`,
  );

  return {
    corpusPath: CORPUS_FILE,
    found: true,
    coverage: corpusCoverage(corpus),
    analysis: analyseVisibility(corpus, subject, host),
    sources: citedSources(corpus),
    problems,
  };
}

/** A rate, rendered with its interval and its counts. Never the value alone. */
function rate(label: string, value: Rate): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  return `  ${label.padEnd(10)} ${pct(value.value).padStart(6)}  [${pct(value.low)} – ${pct(value.high)}]  (${String(value.hits)}/${String(value.attempts)})`;
}

export function formatVisibility(result: VisibilityResult): string {
  if (!result.found) {
    return [
      `No corpus at ${result.corpusPath}.`,
      '',
      'This command reads a recorded run; it does not make one. Querying engines',
      'costs money against your own API key, so it is opt-in and separate.',
      '',
      'Reporting zeros here would be indistinguishable from "nobody mentions you",',
      'and those are opposite facts.',
    ].join('\n');
  }

  const lines: string[] = [];

  if (result.problems.length > 0) {
    lines.push('Problems with the design that produced this corpus:');
    for (const problem of result.problems) lines.push(`  ${problem}`);
    lines.push('');
  }

  const coverage = result.coverage;
  if (coverage !== undefined) {
    lines.push(
      coverage.complete
        ? `Complete run: ${String(coverage.recorded)}/${String(coverage.expected)} cells.`
        : `INCOMPLETE: ${String(coverage.recorded)}/${String(coverage.expected)} cells recorded, ${String(coverage.failed)} failed — every rate below is against a denominator this run did not finish.`,
    );
    lines.push('');
  }

  const analysis = result.analysis;
  if (analysis !== undefined) {
    lines.push(`${analysis.subject} (${analysis.host})`);
    lines.push(rate('answered', analysis.overall.answered));
    lines.push(rate('mention', analysis.overall.mention));
    lines.push(rate('citation', analysis.overall.citation));
    lines.push('');
    lines.push('Per engine:');
    for (const entry of analysis.byEngine) {
      lines.push(`  ${entry.engine}`);
      lines.push(rate('  mention', entry.counts.mention));
      lines.push(rate('  citation', entry.counts.citation));
    }
    lines.push('');
    lines.push('Levels are separate and are never summed. There is no score: an aggregate');
    lines.push('hides a loss at one level behind a gain at another.');
  }

  const sources = result.sources ?? [];
  if (sources.length > 0) {
    lines.push('');
    lines.push('Who actually gets cited (answers citing each host):');
    for (const source of sources.slice(0, 15)) {
      lines.push(`  ${String(source.count).padStart(4)}  ${source.host}`);
    }
    const owned = sources.find((source) => source.host === analysis?.host);
    const total = sources.reduce((sum, source) => sum + source.count, 0);
    lines.push('');
    lines.push(
      owned === undefined
        ? 'Your own domain was cited in none of them.'
        : `Your own domain accounts for ${((owned.count / total) * 100).toFixed(1)}% of these.`,
    );
    lines.push('Across 102,025 published responses that figure was 2.9% — where a project’s');
    lines.push('reputation lives is usually somebody else’s page.');
  }

  return lines.join('\n');
}

/** The size a matrix would cost, for the approval that should precede a run. */
export { matrixSize };

/**
 * Recording a visibility run so it can be compared to the next one
 * (P7-VISIBILITY-01).
 *
 * `sdlc visibility` measures once, and once answers nothing anybody acts on:
 * the question is never "what is the mention rate" but "is it moving". This
 * makes the second question askable, on a cadence — the command is
 * cron-friendly and the product deliberately ships **no scheduler of its own**,
 * because a workspace that already has cron, CI or a task runner does not need
 * a second one and cannot be asked to trust ours with credentials.
 *
 * **Hits and attempts are stored, never a rate.** The Wilson interval needs the
 * counts, so a row holding `0.42` would make every interval unrecomputable —
 * and the intervals are the entire point of this feature.
 */

export interface SnapshotResult {
  readonly subject: string;
  readonly ranAt: string;
  readonly recorded: boolean;
  readonly problems: readonly string[];
}

/**
 * Records the latest corpus as a snapshot.
 *
 * Refuses when the corpus has matrix problems. A corpus produced by a design
 * that could not support its own claim is still a corpus and is still worth
 * *reading* — `sdlc visibility` shows it, problems and all — but recording it
 * into a trend would launder a bad run into a data point, and the trend is what
 * somebody eventually puts in front of a stakeholder.
 */
export async function snapshotVisibility(
  root: string,
  subject: string,
  host: string,
  options: { readonly ranAt?: string | undefined } = {},
): Promise<SnapshotResult> {
  const result = await readVisibility(root, subject, host);

  if (!result.found) {
    return {
      subject,
      ranAt: options.ranAt ?? '',
      recorded: false,
      problems: [`no corpus at ${result.corpusPath} — nothing to snapshot`],
    };
  }
  if (result.problems.length > 0 || result.analysis === undefined) {
    return {
      subject,
      ranAt: options.ranAt ?? '',
      recorded: false,
      problems: result.problems.length > 0 ? result.problems : ['corpus could not be analysed'],
    };
  }

  const analysis = result.analysis;
  const ranAt = options.ranAt ?? new Date().toISOString();

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{ id: number }>(
      `INSERT INTO visibility_snapshots
         (ran_at, subject, host, answered_hits, answered_attempts,
          mention_hits, mention_attempts, citation_hits, citation_attempts,
          failures, corpus_path)
       VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (subject, ran_at) DO NOTHING
       RETURNING id;`,
      [
        ranAt,
        subject,
        host,
        analysis.overall.answered.hits,
        analysis.overall.answered.attempts,
        analysis.overall.mention.hits,
        analysis.overall.mention.attempts,
        analysis.overall.citation.hits,
        analysis.overall.citation.attempts,
        analysis.failures,
        result.corpusPath,
      ],
    );
    return { subject, ranAt, recorded: rows.length > 0, problems: [] };
  } finally {
    await db.close();
  }
}

export async function visibilityTrendFor(root: string, subject: string): Promise<VisibilityTrend> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{
      ran_at: string;
      subject: string;
      host: string;
      answered_hits: number;
      answered_attempts: number;
      mention_hits: number;
      mention_attempts: number;
      citation_hits: number;
      citation_attempts: number;
      failures: number;
    }>(
      `SELECT ran_at, subject, host, answered_hits, answered_attempts,
              mention_hits, mention_attempts, citation_hits, citation_attempts, failures
         FROM visibility_snapshots WHERE subject = $1 ORDER BY ran_at ASC;`,
      [subject],
    );

    // Intervals are recomputed from the stored counts on every read rather than
    // stored alongside them. A stored interval and a stored count can disagree;
    // recomputing makes that impossible.
    return visibilityTrend(
      rows.map((row) => ({
        at: new Date(String(row.ran_at)).toISOString(),
        subject: row.subject,
        host: row.host,
        answered: wilson(row.answered_hits, row.answered_attempts),
        mention: wilson(row.mention_hits, row.mention_attempts),
        citation: wilson(row.citation_hits, row.citation_attempts),
        failures: row.failures,
      })),
    );
  } finally {
    await db.close();
  }
}

export { formatVisibilityTrend };

export function formatSnapshot(result: SnapshotResult): string {
  if (result.recorded) {
    return `recorded a visibility snapshot for ${result.subject} at ${result.ranAt}`;
  }
  return [
    `no snapshot recorded for ${result.subject}`,
    ...result.problems.map((problem) => `  ✗ ${problem}`),
    '',
    'A corpus with matrix problems is still worth reading — `sdlc visibility`',
    'shows it — but recording it into a trend would launder a bad run into a',
    'data point.',
  ].join('\n');
}

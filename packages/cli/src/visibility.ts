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
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';

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

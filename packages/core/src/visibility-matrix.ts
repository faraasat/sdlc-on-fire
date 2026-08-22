/**
 * The measured-visibility harness: the query matrix (P5-VIZ-01, ADR-0074).
 *
 * An instrument, not a dashboard. It defines what will be asked, of whom, how
 * many times — and records every raw response as the evidence artifact. What it
 * does *not* do is decide anything: the analysis over the recorded corpus is
 * [`visibility-analysis.ts`](visibility-analysis.ts), and it is deterministic
 * and offline.
 *
 * **Breadth before depth**, which is the finding that shaped this file. A
 * variance-components decomposition of 12,933 responses puts a single AI answer
 * at a reliability of Eρ² ≈ 0.01 and a fully crossed design at ≈0.36; the object
 * being measured accounts for **0.7%** of variance while query language accounts
 * for **31.6%**, and repeats past ~5 are roughly fifteen times less effective
 * than adding one condition (~[arXiv 2607.13304](https://arxiv.org/html/2607.13304v1),
 * `techniques/47` §2). So the matrix spends its budget on paraphrases and
 * models first and caps repeats — the opposite of field convention, and the
 * reason this is a matrix rather than a loop.
 *
 * **The denominator is always visible.** Every cell of the matrix is declared
 * before anything runs, so a count can always be divided by the number of
 * attempts that produced it. A harness that discovered its own denominator as
 * it went would report a rate whose bottom half nobody could reconstruct.
 */

/** The engines a run may target. Extending this is a scope decision, not a config change. */
export const VISIBILITY_ENGINES = ['openai', 'anthropic', 'perplexity', 'google'] as const;
export type VisibilityEngine = (typeof VISIBILITY_ENGINES)[number];

/**
 * Repeats per cell.
 *
 * Five, and capped. The evidence says the fifth repeat onward reduces
 * relative-error variance by 0.0003 — about fifteen times less than adding one
 * condition — so anything above this is budget that would measure more if it
 * were spent on a paraphrase.
 */
export const MAX_REPEATS = 5;

export interface MatrixCell {
  readonly prompt: string;
  /** Which rewording of the question this is. Index into the prompt's paraphrases. */
  readonly paraphrase: number;
  readonly engine: VisibilityEngine;
  readonly repeat: number;
}

export interface MatrixSpec {
  /** One question, in several wordings. Breadth lives here. */
  readonly prompts: readonly { readonly id: string; readonly paraphrases: readonly string[] }[];
  readonly engines: readonly VisibilityEngine[];
  readonly repeats: number;
}

export interface MatrixProblem {
  readonly field: string;
  readonly because: string;
}

/**
 * Check a matrix before it costs anything.
 *
 * Every problem here is a *refusal*. A run of this instrument costs real money
 * against somebody's API key, and discovering halfway through that the design
 * cannot support the claim it was built to make is the most expensive possible
 * moment to find out.
 */
export function validateMatrix(spec: MatrixSpec): readonly MatrixProblem[] {
  const problems: MatrixProblem[] = [];

  if (spec.prompts.length === 0) {
    problems.push({ field: 'prompts', because: 'a matrix with no question measures nothing' });
  }
  if (spec.engines.length === 0) {
    problems.push({ field: 'engines', because: 'no engine to ask' });
  }
  if (spec.repeats < 1) {
    problems.push({ field: 'repeats', because: 'at least one repeat is needed' });
  }
  if (spec.repeats > MAX_REPEATS) {
    problems.push({
      field: 'repeats',
      because: `${String(spec.repeats)} repeats: past ${String(MAX_REPEATS)} this buys about fifteen times less than one more paraphrase or engine — spend it on breadth`,
    });
  }

  for (const prompt of spec.prompts) {
    if (prompt.paraphrases.length === 0) {
      problems.push({ field: `prompts.${prompt.id}`, because: 'no wording to ask' });
    }
    if (prompt.paraphrases.length === 1 && spec.repeats > 1) {
      // The single most common way to burn a budget on nothing: one wording
      // asked five times measures the sampler, not the question.
      problems.push({
        field: `prompts.${prompt.id}`,
        because:
          'one wording repeated: query wording accounts for ~31.6% of variance and the subject for ~0.7%, so this measures the sampler',
      });
    }
    const unique = new Set(prompt.paraphrases.map((p) => p.trim().toLowerCase()));
    if (unique.size !== prompt.paraphrases.length) {
      problems.push({
        field: `prompts.${prompt.id}`,
        because: 'duplicate paraphrases — the same wording counted twice inflates the denominator',
      });
    }
  }

  return problems;
}

/**
 * Expand a matrix into the cells that will be run.
 *
 * Ordered engine-major then paraphrase then repeat, so a run interrupted
 * partway has covered *breadth* rather than having exhausted every repeat of
 * the first wording. A partial run of a well-ordered matrix is still a usable
 * sample; a partial run of a badly-ordered one is five answers to one question.
 */
export function expandMatrix(spec: MatrixSpec): readonly MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (let repeat = 1; repeat <= spec.repeats; repeat += 1) {
    for (const prompt of spec.prompts) {
      for (let paraphrase = 0; paraphrase < prompt.paraphrases.length; paraphrase += 1) {
        for (const engine of spec.engines) {
          cells.push({
            prompt: prompt.paraphrases[paraphrase] ?? '',
            paraphrase,
            engine,
            repeat,
          });
        }
      }
    }
  }
  return cells;
}

/** How many calls a matrix will make. The number somebody approves before it runs. */
export function matrixSize(spec: MatrixSpec): number {
  const paraphrases = spec.prompts.reduce((sum, prompt) => sum + prompt.paraphrases.length, 0);
  return paraphrases * spec.engines.length * spec.repeats;
}

/** One recorded answer. The evidence artifact — never summarised at capture time. */
export interface RecordedResponse {
  readonly cell: MatrixCell;
  /** The engine's answer, verbatim. */
  readonly text: string;
  /** URLs the engine cited, as it gave them. */
  readonly citations: readonly string[];
  /** ISO timestamp. Supplied by the caller; this module reads no clock. */
  readonly at: string;
  /** Set when the call failed. A failed cell is recorded, never dropped. */
  readonly error?: string | undefined;
}

/**
 * A corpus is the run.
 *
 * It carries its own matrix, so an analysis can always recover the denominator
 * from the artifact rather than from whoever remembers what was run.
 */
export interface ResponseCorpus {
  readonly spec: MatrixSpec;
  readonly responses: readonly RecordedResponse[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/**
 * Whether a corpus actually covers the matrix it claims.
 *
 * A run that failed halfway produces a corpus whose denominators are wrong in a
 * way nothing downstream can detect — the counts look fine, the rates are
 * computed against attempts that never happened. This is the check that turns
 * that into a visible fact.
 */
export function corpusCoverage(corpus: ResponseCorpus): {
  expected: number;
  recorded: number;
  failed: number;
  complete: boolean;
} {
  const expected = matrixSize(corpus.spec);
  const failed = corpus.responses.filter((response) => response.error !== undefined).length;
  return {
    expected,
    recorded: corpus.responses.length,
    failed,
    complete: corpus.responses.length === expected && failed === 0,
  };
}

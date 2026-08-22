import { describe, expect, it } from 'vitest';
import {
  MAX_REPEATS,
  corpusCoverage,
  expandMatrix,
  matrixSize,
  validateMatrix,
  type MatrixSpec,
  type ResponseCorpus,
} from './visibility-matrix.js';

/**
 * P5-VIZ-01 — the query matrix.
 *
 * Everything here defends one finding: the subject being measured accounts for
 * ~0.7% of variance and query wording for ~31.6%, so budget spent on repeats is
 * budget measuring the sampler. A harness that made the convenient choice —
 * one wording, many repeats — would produce confident numbers about nothing.
 */

const spec = (over: Partial<MatrixSpec> = {}): MatrixSpec => ({
  prompts: [{ id: 'q1', paraphrases: ['what is X', 'how does X work'] }],
  engines: ['openai', 'anthropic'],
  repeats: 3,
  ...over,
});

describe('validateMatrix', () => {
  it('accepts a matrix with breadth', () => {
    expect(validateMatrix(spec())).toEqual([]);
  });

  it('refuses one wording repeated, which measures the sampler', () => {
    // The single most common way to burn a budget on nothing.
    const problems = validateMatrix(spec({ prompts: [{ id: 'q1', paraphrases: ['only one'] }] }));
    expect(problems.some((p) => p.because.includes('measures the sampler'))).toBe(true);
  });

  it('allows a single wording when it is asked once', () => {
    const problems = validateMatrix(
      spec({ prompts: [{ id: 'q1', paraphrases: ['only one'] }], repeats: 1 }),
    );
    expect(problems).toEqual([]);
  });

  it('refuses more repeats than the evidence supports', () => {
    const problems = validateMatrix(spec({ repeats: MAX_REPEATS + 1 }));
    expect(problems.some((p) => p.field === 'repeats')).toBe(true);
    expect(problems[0]?.because).toContain('spend it on breadth');
  });

  it('refuses duplicate paraphrases, which inflate the denominator', () => {
    const problems = validateMatrix(
      spec({ prompts: [{ id: 'q1', paraphrases: ['same', ' Same '] }] }),
    );
    expect(problems.some((p) => p.because.includes('duplicate'))).toBe(true);
  });

  it('refuses an empty matrix rather than running nothing successfully', () => {
    expect(validateMatrix(spec({ prompts: [] })).length).toBeGreaterThan(0);
    expect(validateMatrix(spec({ engines: [] })).length).toBeGreaterThan(0);
  });

  it('collects every problem, because each run costs real money', () => {
    const problems = validateMatrix({ prompts: [], engines: [], repeats: 99 });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('matrixSize', () => {
  it('is the number somebody approves before it runs', () => {
    // 2 paraphrases x 2 engines x 3 repeats
    expect(matrixSize(spec())).toBe(12);
  });

  it('counts paraphrases, not prompts', () => {
    const two = spec({
      prompts: [
        { id: 'a', paraphrases: ['x', 'y', 'z'] },
        { id: 'b', paraphrases: ['p'] },
      ],
      engines: ['openai'],
      repeats: 1,
    });
    expect(matrixSize(two)).toBe(4);
  });
});

describe('expandMatrix', () => {
  it('produces one cell per call', () => {
    expect(expandMatrix(spec())).toHaveLength(matrixSize(spec()));
  });

  it('covers breadth before depth, so a partial run is still a sample', () => {
    // Repeat-major ordering: every wording and engine is seen once before any
    // second repeat. A run cut short mid-way has a usable sample rather than
    // five answers to one question.
    //
    // Two prompts, deliberately. With one prompt the outer two loops can be
    // swapped and the first pass is identical — an earlier version of this test
    // used one and held with the ordering inverted.
    const wide = spec({
      prompts: [
        { id: 'a', paraphrases: ['a1', 'a2'] },
        { id: 'b', paraphrases: ['b1', 'b2'] },
      ],
      repeats: 2,
    });
    const cells = expandMatrix(wide);
    const firstPass = cells.slice(0, 8);

    expect(firstPass.every((c) => c.repeat === 1)).toBe(true);
    expect(new Set(firstPass.map((c) => c.prompt)).size).toBe(4);
    expect(new Set(firstPass.map((c) => c.engine)).size).toBe(2);
    // The decisive one: both prompts appear before the first repeat does.
    const firstRepeatTwo = cells.findIndex((c) => c.repeat === 2);
    const promptsBefore = new Set(cells.slice(0, firstRepeatTwo).map((c) => c.prompt));
    expect(promptsBefore.size).toBe(4);
  });

  it('records which paraphrase each cell used', () => {
    const cells = expandMatrix(spec());
    expect(new Set(cells.map((c) => c.paraphrase))).toEqual(new Set([0, 1]));
  });

  it('is deterministic', () => {
    expect(expandMatrix(spec())).toEqual(expandMatrix(spec()));
  });
});

describe('corpusCoverage', () => {
  const corpus = (over: Partial<ResponseCorpus> = {}): ResponseCorpus => ({
    spec: spec(),
    responses: expandMatrix(spec()).map((cell) => ({
      cell,
      text: 'an answer',
      citations: [],
      at: '2026-08-22T00:00:00.000Z',
    })),
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: '2026-08-22T00:05:00.000Z',
    ...over,
  });

  it('reports a complete run as complete', () => {
    expect(corpusCoverage(corpus()).complete).toBe(true);
  });

  it('catches a run that stopped halfway', () => {
    // The counts would look fine and the rates would be computed against
    // attempts that never happened — invisible to everything downstream.
    const partial = corpus();
    const coverage = corpusCoverage({ ...partial, responses: partial.responses.slice(0, 5) });
    expect(coverage.recorded).toBe(5);
    expect(coverage.expected).toBe(12);
    expect(coverage.complete).toBe(false);
  });

  it('counts a failed cell as recorded but not complete', () => {
    // A failed call is recorded, never dropped: dropping it would silently
    // shrink the denominator and inflate every rate computed from it.
    const full = corpus();
    const withError = full.responses.map((r, i) => (i === 0 ? { ...r, error: 'rate limited' } : r));
    const coverage = corpusCoverage({ ...full, responses: withError });
    expect(coverage.recorded).toBe(12);
    expect(coverage.failed).toBe(1);
    expect(coverage.complete).toBe(false);
  });

  it('recovers the denominator from the artifact, not from memory', () => {
    // The corpus carries its own spec, so an analysis run months later does not
    // depend on anyone remembering what was asked.
    expect(corpusCoverage(corpus()).expected).toBe(matrixSize(spec()));
  });
});

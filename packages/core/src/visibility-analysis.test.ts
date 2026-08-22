import { describe, expect, it } from 'vitest';
import {
  analyseVisibility,
  citedSources,
  citesHost,
  mentions,
  wilson,
} from './visibility-analysis.js';
import {
  expandMatrix,
  type MatrixSpec,
  type RecordedResponse,
  type ResponseCorpus,
} from './visibility-matrix.js';

/**
 * P5-VIZ-02 — the deterministic half.
 *
 * Pure throughout: same corpus, same numbers, no network, no clock. The
 * assertions defend the three ADR-0074 rules that are easiest to erode —
 * intervals always present, levels never summed, sentiment absent.
 */

const spec: MatrixSpec = {
  prompts: [{ id: 'q', paraphrases: ['what tool for X', 'best X tool'] }],
  engines: ['openai', 'anthropic'],
  repeats: 2,
};

const corpusOf = (texts: string[], citations: string[][] = []): ResponseCorpus => {
  const cells = expandMatrix(spec);
  const responses: RecordedResponse[] = texts.map((text, i) => ({
    cell: cells[i % cells.length] ?? cells[0]!,
    text,
    citations: citations[i] ?? [],
    at: '2026-08-22T00:00:00.000Z',
  }));
  return {
    spec,
    responses,
    startedAt: '2026-08-22T00:00:00.000Z',
    finishedAt: '2026-08-22T00:01:00.000Z',
  };
};

describe('wilson', () => {
  it('never reports certainty from a small sample', () => {
    // The normal approximation gives [0, 0] for 0/12 — a confident claim of
    // impossibility from twelve observations. A harness whose purpose is
    // refusing overconfident numbers cannot ship the overconfident interval.
    const rate = wilson(0, 12);
    expect(rate.value).toBe(0);
    expect(rate.low).toBe(0);
    expect(rate.high).toBeGreaterThan(0.15);
  });

  it('never reports certainty at the top either', () => {
    const rate = wilson(12, 12);
    // Wilson's upper bound at p=1 is exactly 1 — the terms cancel — so the
    // assertion is on the mathematics, not on the last bit of the float. The
    // half that carries the meaning is `low`: twelve out of twelve is not
    // evidence that the true rate is above 85%.
    expect(rate.high).toBeCloseTo(1, 10);
    expect(rate.low).toBeLessThan(0.85);
  });

  it('narrows as the sample grows', () => {
    const small = wilson(5, 10);
    const large = wilson(500, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('brackets the point estimate', () => {
    for (const [h, n] of [
      [1, 3],
      [7, 9],
      [13, 40],
    ] as const) {
      const rate = wilson(h, n);
      expect(rate.low).toBeLessThanOrEqual(rate.value);
      expect(rate.high).toBeGreaterThanOrEqual(rate.value);
    }
  });

  it('reports total ignorance for an empty sample rather than dividing by zero', () => {
    expect(wilson(0, 0)).toMatchObject({ value: 0, low: 0, high: 1 });
  });

  it('always carries the counts it came from', () => {
    // The number can always be checked against its denominator.
    expect(wilson(3, 8)).toMatchObject({ hits: 3, attempts: 8 });
  });
});

describe('mentions', () => {
  it('matches a whole word, case-insensitively', () => {
    expect(mentions('I recommend Hono for this', 'hono')).toBe(true);
    expect(mentions('use HONO', 'Hono')).toBe(true);
  });

  it('does not match inside another word', () => {
    // Substring matching would count "Honolulu" as a mention of "Hono".
    expect(mentions('a trip to Honolulu', 'Hono')).toBe(false);
  });

  it('matches next to punctuation, which is where names actually appear', () => {
    expect(mentions('Try Hono, it is small.', 'Hono')).toBe(true);
    expect(mentions('(Hono)', 'Hono')).toBe(true);
  });

  it('treats regex characters in the subject as literal', () => {
    // A subject like `c++` must not be compiled as a quantifier.
    expect(mentions('written in c++ mostly', 'c++')).toBe(true);
    expect(() => mentions('anything', '[')).not.toThrow();
  });

  it('is false for an empty subject rather than matching everything', () => {
    expect(mentions('any text', '  ')).toBe(false);
  });
});

describe('citesHost', () => {
  it('matches on host, not on substring', () => {
    // `notexample.com` contains `example.com`.
    expect(citesHost(['https://notexample.com/a'], 'example.com')).toBe(false);
    expect(citesHost(['https://example.com/a'], 'example.com')).toBe(true);
  });

  it('ignores a leading www', () => {
    expect(citesHost(['https://www.example.com/a'], 'example.com')).toBe(true);
  });

  it('ignores a citation that is not a URL', () => {
    expect(citesHost(['see the docs'], 'example.com')).toBe(false);
  });
});

describe('analyseVisibility', () => {
  it('reports mention and citation separately, never summed', () => {
    // ADR-0074: a composite hides an upstream loss behind a downstream gain.
    const analysis = analyseVisibility(
      corpusOf(['Hono is good', 'try Fastify'], [['https://hono.dev/x'], []]),
      'Hono',
      'hono.dev',
    );
    expect(analysis.overall.mention.hits).toBe(1);
    expect(analysis.overall.citation.hits).toBe(1);
    expect(analysis).not.toHaveProperty('score');
    expect(analysis.overall).not.toHaveProperty('total');
  });

  it('exposes no sentiment, at any budget', () => {
    // 45.5% flip rate against 6.8% for mention. Reporting it from this sample
    // is a coin flip with a decimal point on it.
    const analysis = analyseVisibility(corpusOf(['Hono is good']), 'Hono', 'hono.dev');
    expect(JSON.stringify(analysis)).not.toContain('sentiment');
  });

  it('gives every rate an interval', () => {
    const analysis = analyseVisibility(corpusOf(['Hono', 'no']), 'Hono', 'hono.dev');
    for (const rate of [
      analysis.overall.mention,
      analysis.overall.citation,
      analysis.overall.answered,
    ]) {
      expect(typeof rate.low).toBe('number');
      expect(typeof rate.high).toBe('number');
    }
  });

  it('separates "the API was down" from "nobody mentions you"', () => {
    // Two different facts with the same shape. Folding failures into the
    // mention denominator would report an outage as an absence.
    const base = corpusOf(['Hono is good', 'Hono again']);
    const withFailure = {
      ...base,
      responses: [...base.responses, { ...base.responses[0]!, text: '', error: 'rate limited' }],
    };
    const analysis = analyseVisibility(withFailure, 'Hono', 'hono.dev');
    expect(analysis.failures).toBe(1);
    expect(analysis.overall.mention.attempts).toBe(2);
    expect(analysis.overall.mention.value).toBe(1);
    expect(analysis.overall.answered.attempts).toBe(3);
  });

  it('breaks results down by engine, because model identity is a condition', () => {
    const analysis = analyseVisibility(corpusOf(['Hono', 'no', 'Hono', 'no']), 'Hono', 'hono.dev');
    expect(analysis.byEngine.map((e) => e.engine)).toEqual(['anthropic', 'openai']);
  });

  it('is deterministic', () => {
    const corpus = corpusOf(['Hono is good', 'try Fastify']);
    expect(analyseVisibility(corpus, 'Hono', 'hono.dev')).toEqual(
      analyseVisibility(corpus, 'Hono', 'hono.dev'),
    );
  });
});

describe('citedSources', () => {
  it('ranks the hosts that actually get cited', () => {
    // Where a project's reputation lives is somebody else's page: only ~2.9% of
    // citations point at an owned domain.
    const corpus = corpusOf(
      ['a', 'b', 'c'],
      [
        ['https://github.com/x', 'https://hono.dev/y'],
        ['https://github.com/z'],
        ['https://reddit.com/r/x'],
      ],
    );
    expect(citedSources(corpus)).toEqual([
      { host: 'github.com', count: 2 },
      { host: 'hono.dev', count: 1 },
      { host: 'reddit.com', count: 1 },
    ]);
  });

  it('counts a host once per response, not once per citation', () => {
    // Otherwise one verbose answer citing the same page three times outweighs
    // three answers citing it once.
    const corpus = corpusOf(['a'], [['https://x.com/1', 'https://x.com/2', 'https://x.com/3']]);
    expect(citedSources(corpus)).toEqual([{ host: 'x.com', count: 1 }]);
  });

  it('ignores citations that are not URLs', () => {
    expect(citedSources(corpusOf(['a'], [['see the docs']]))).toEqual([]);
  });

  it('carries no interval, because it is a count and not an estimate', () => {
    const sources = citedSources(corpusOf(['a'], [['https://x.com/1']]));
    expect(sources[0]).not.toHaveProperty('low');
  });
});

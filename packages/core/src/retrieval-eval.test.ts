import { describe, expect, it } from 'vitest';
import {
  evaluateRetrieval,
  RelevanceSetSchema,
  scoreQuery,
  type RelevanceJudgement,
} from './retrieval-eval.js';

const judgement = (over: Partial<RelevanceJudgement> = {}): RelevanceJudgement => ({
  query: 'how do gates block an advance',
  relevant: ['docs a 0', 'docs a 1', 'docs b 0'],
  judged_by: 'farasat',
  judged_on: '2026-08-24',
  ...over,
});

describe('precision@k (P6-INSTRUMENT-01, FEAT-MET-012)', () => {
  it('divides by k, not by what was returned', () => {
    // A retriever that returns two results and gets both right has not achieved
    // precision 1.0 at k=10 — it failed to fill the slots. Dividing by what came
    // back reports that as perfect.
    const score = scoreQuery(judgement(), ['docs a 0', 'docs a 1'], 10);
    expect(score.precision).toBeCloseTo(0.2);
    expect(score.retrieved).toBe(2);
  });

  it('reports the ceiling the corpus imposes', () => {
    // Three relevant chunks can never exceed 0.3 at k=10. Printing that beside a
    // target of 0.8 makes a perfect retriever look broken, which is how a
    // measurement gets argued away rather than acted on.
    const perfect = scoreQuery(
      judgement(),
      ['docs a 0', 'docs a 1', 'docs b 0', 'x 1', 'x 2', 'x 3', 'x 4', 'x 5', 'x 6', 'x 7'],
      10,
    );
    expect(perfect.precision).toBeCloseTo(0.3);
    expect(perfect.ceiling).toBeCloseTo(0.3);
    // The number that says the retriever did everything it could.
    expect(perfect.ofCeiling).toBeCloseTo(1);
  });

  it('counts only the top k, however many were handed in', () => {
    // A relevant chunk at rank 11 did not reach the agent. Scoring it would
    // measure the corpus rather than the ranking.
    const score = scoreQuery(
      judgement({ relevant: ['deep'] }),
      ['a', 'b', 'c', 'd', 'e', 'deep'],
      5,
    );
    expect(score.hits).toBe(0);
    expect(score.missed).toEqual(['deep']);
  });

  it('reports recall, which precision cannot see', () => {
    // Precision says what came back was good. Recall says what was missed, and
    // a retriever can score well on the first while losing two thirds of the
    // answer.
    const score = scoreQuery(judgement(), ['docs a 0'], 1);
    expect(score.precision).toBeCloseTo(1);
    expect(score.recall).toBeCloseTo(1 / 3);
  });
});

describe('evaluating a set', () => {
  it('names the queries that returned nothing useful', () => {
    // A mean hides the query that is completely blind, and that query is the one
    // worth reading.
    const good = scoreQuery(judgement({ query: 'a' }), ['docs a 0'], 3);
    const blind = scoreQuery(judgement({ query: 'b' }), ['nope', 'also nope'], 3);
    const report = evaluateRetrieval([good, blind], 3);
    expect(report.blind).toEqual(['b']);
    expect(report.meanPrecision).toBeCloseTo(1 / 6);
  });

  it('reports nothing rather than zero for an empty set', () => {
    const report = evaluateRetrieval([], 10);
    expect(report.meanPrecision).toBeNull();
    expect(report.meanRecall).toBeNull();
  });
});

describe('the relevance set schema', () => {
  const valid = {
    schema_version: '0.1.0',
    held_out: true,
    judgements: [judgement()],
  };

  it('accepts a judged, attributed, held-out set', () => {
    expect(RelevanceSetSchema.safeParse(valid).success).toBe(true);
  });

  it('refuses a judgement with no author', () => {
    // A judgement nobody signed cannot be argued with later, which is the whole
    // property that makes the set worth keeping.
    const { judged_by: _dropped, ...unsigned } = judgement();
    expect(RelevanceSetSchema.safeParse({ ...valid, judgements: [unsigned] }).success).toBe(false);
  });

  it('refuses a set that does not declare itself held out', () => {
    // The discipline is only real if breaking it means editing a line that says
    // so (P7-HELDOUT-01). A default would let it be broken by omission.
    expect(RelevanceSetSchema.safeParse({ ...valid, held_out: false }).success).toBe(false);
    const { held_out: _dropped, ...noFlag } = valid;
    expect(RelevanceSetSchema.safeParse(noFlag).success).toBe(false);
  });

  it('refuses an empty set', () => {
    // An empty relevance set scores every retriever identically and reports it
    // as a measurement.
    expect(RelevanceSetSchema.safeParse({ ...valid, judgements: [] }).success).toBe(false);
  });

  it('refuses a judgement with no relevant chunks', () => {
    // "Nothing is relevant to this query" is not a judgement anything can be
    // scored against — precision would be 0 for every retriever forever.
    expect(
      RelevanceSetSchema.safeParse({ ...valid, judgements: [judgement({ relevant: [] })] }).success,
    ).toBe(false);
  });
});

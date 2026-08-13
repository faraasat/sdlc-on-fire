import { describe, expect, it, vi } from 'vitest';
import type { HybridHit } from './hybrid.js';
import {
  broadenQuery,
  CORRECTIVE_THRESHOLDS,
  evaluateRetrieval,
  formatCorrective,
  type RetrievalEvaluator,
} from './corrective.js';

/**
 * P2-CTX-01 — Corrective-RAG evaluation.
 *
 * The property that matters throughout: nothing can quietly upgrade weak
 * context to trusted. That is the one failure downstream cannot detect, because
 * a pack full of irrelevant chunks looks exactly like a pack full of relevant
 * ones.
 */

const hit = (score: number, text = 'some passage'): HybridHit => ({
  id: `chunk-${String(score)}`,
  sourceTable: 'docs',
  sourceId: 'doc-1',
  index: 0,
  text,
  score,
  legs: ['lexical'],
});

describe('evaluateRetrieval — decided without a model', () => {
  it('calls an empty result incorrect, and says why in those terms', async () => {
    const result = await evaluateRetrieval('anything', []);
    expect(result.verdict).toBe('incorrect');
    expect(result.decidedBy).toBe('deterministic');
    expect(result.action).toBe('requery');

    // The verdict alone is also produced by the score-floor check below, since
    // an empty list has a top score of zero — so asserting only the verdict
    // left this branch unpinned. What the branch actually contributes is the
    // message: "best hit scored 0.000, below the 0.15 floor" is a confusing
    // thing to tell someone when there were no hits at all.
    expect(result.reason).toContain('returned nothing');
    expect(result.reason).not.toContain('floor');
  });

  it('calls a weak top score incorrect', async () => {
    const result = await evaluateRetrieval('q', [hit(0.05), hit(0.02)]);
    expect(result.verdict).toBe('incorrect');
    expect(result.reason).toContain('floor');
  });

  it('calls a strong, clearly-leading top score correct', async () => {
    const result = await evaluateRetrieval('q', [hit(0.9), hit(0.3)]);
    expect(result.verdict).toBe('correct');
    expect(result.decidedBy).toBe('deterministic');
    expect(result.action).toBe('insert');
  });

  it('does not call a strong score correct without a margin', async () => {
    // Several passages scoring alike means the retrieval could not separate
    // them, which is precisely the case a judgement is for.
    const result = await evaluateRetrieval('q', [hit(0.9), hit(0.88)]);
    expect(result.verdict).not.toBe('correct');
  });

  it('never asks a model when the answer is already available', async () => {
    const evaluator = vi.fn<RetrievalEvaluator>(() => Promise.resolve('incorrect'));
    await evaluateRetrieval('q', [hit(0.9), hit(0.1)], { evaluator });
    await evaluateRetrieval('q', [], { evaluator });
    // Latency and variance added to a conclusion already in hand.
    expect(evaluator).not.toHaveBeenCalled();
  });

  it('keeps its thresholds nameable rather than inlined', () => {
    // Starting values tuned against nothing; the first real usage data should
    // move them, and a number buried in a conditional is one nobody revisits.
    expect(CORRECTIVE_THRESHOLDS.scoreFloor).toBe(0.15);
    expect(CORRECTIVE_THRESHOLDS.scoreCeiling).toBe(0.75);
  });
});

describe('evaluateRetrieval — the middle band', () => {
  const middling = [hit(0.5, 'a'), hit(0.45, 'b'), hit(0.4, 'c')];

  it('consults the evaluator', async () => {
    const evaluator = vi.fn<RetrievalEvaluator>(() => Promise.resolve('correct'));
    const result = await evaluateRetrieval('q', middling, { evaluator });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(result.verdict).toBe('correct');
    expect(result.decidedBy).toBe('evaluator');
  });

  it('passes the query and a bounded sample of passages', async () => {
    let seen: { query: string; passages: readonly string[] } | null = null;
    await evaluateRetrieval(
      'how does auth work',
      Array.from({ length: 20 }, (_, i) => hit(0.5, `passage ${String(i)}`)),
      {
        evaluator: (input) => {
          seen = input;
          return Promise.resolve('correct');
        },
        sampleSize: 3,
      },
    );
    expect(seen!.query).toBe('how does auth work');
    expect(seen!.passages).toHaveLength(3);
  });

  it('requeries when the evaluator says incorrect', async () => {
    const result = await evaluateRetrieval('q', middling, {
      evaluator: () => Promise.resolve('incorrect'),
    });
    expect(result.action).toBe('requery');
    expect(result.requery).toBeDefined();
  });

  it('flags rather than trusting when the evaluator fails', async () => {
    const result = await evaluateRetrieval('q', middling, {
      evaluator: () => Promise.reject(new Error('timeout')),
    });
    // Failing toward `correct` would let an outage insert weak context as
    // trusted — the one outcome nothing downstream can detect.
    expect(result.verdict).toBe('ambiguous');
    expect(result.action).toBe('insert-flagged');
    expect(result.decidedBy).toBe('evaluator-unavailable');
  });

  it('flags when the evaluator declines to conclude', async () => {
    const result = await evaluateRetrieval('q', middling, {
      evaluator: () => Promise.resolve(null),
    });
    expect(result.verdict).toBe('ambiguous');
    // Distinct from a failure: the model answered, and its answer was "I
    // cannot tell", which is more useful than a guess.
    expect(result.decidedBy).toBe('evaluator');
  });

  it('skips the evaluator at low effort and flags instead', async () => {
    const evaluator = vi.fn<RetrievalEvaluator>(() => Promise.resolve('correct'));
    const result = await evaluateRetrieval('q', middling, { evaluator, effort: 'low' });
    expect(evaluator).not.toHaveBeenCalled();
    // A cheap tier should cost less, not silently trust more.
    expect(result.verdict).toBe('ambiguous');
  });

  it('flags when no evaluator is configured at all', async () => {
    const result = await evaluateRetrieval('q', middling);
    expect(result.verdict).toBe('ambiguous');
    expect(result.reason).toContain('no evaluator');
  });
});

describe('the action for each verdict is fixed', () => {
  const cases: readonly [string, HybridHit[], string][] = [
    ['correct', [hit(0.9), hit(0.1)], 'insert'],
    ['incorrect', [], 'requery'],
  ];

  for (const [verdict, hits, action] of cases) {
    it(`${verdict} always means ${action}`, async () => {
      expect((await evaluateRetrieval('q', hits)).action).toBe(action);
    });
  }

  it('ambiguous always means insert-flagged', async () => {
    const result = await evaluateRetrieval('q', [hit(0.5), hit(0.49)]);
    // The evaluator classifies; it never gets to decide to skip the flag.
    expect(result.action).toBe('insert-flagged');
  });
});

describe('broadenQuery', () => {
  it('drops quoted phrases that over-constrained the search', () => {
    expect(broadenQuery('find "exact phrase here" in the retry handler')).not.toContain(
      'exact phrase here',
    );
  });

  it('keeps the identifiers', () => {
    const broadened = broadenQuery('where is computeDiscount called from');
    expect(broadened).toContain('computeDiscount');
  });

  it('drops bare numbers and very short tokens', () => {
    const broadened = broadenQuery('error 500 in the payment flow');
    expect(broadened).not.toContain('500');
    expect(broadened.split(' ')).not.toContain('in');
  });

  it('preserves the order the tokens appeared in', () => {
    // A requery should read like a query, not a bag of words.
    expect(broadenQuery('alpha bravo charlie delta')).toBe('alpha bravo charlie delta');
  });

  it('falls back to the original rather than returning nothing', () => {
    expect(broadenQuery('a b c')).toBe('a b c');
  });

  it('is deduplicated', () => {
    expect(broadenQuery('retry retry retry handler')).toBe('retry handler');
  });
});

describe('formatCorrective', () => {
  it('offers the requery to try', async () => {
    const text = formatCorrective(await evaluateRetrieval('where is computeDiscount', []));
    expect(text).toContain('retry with:');
    expect(text).toContain('computeDiscount');
  });

  it('says a flagged insert is flagged', async () => {
    const text = formatCorrective(await evaluateRetrieval('q', [hit(0.5), hit(0.49)]));
    expect(text).toContain('low-confidence');
  });
});

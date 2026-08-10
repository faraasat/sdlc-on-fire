import { describe, expect, it } from 'vitest';
import {
  decomposeClaim,
  isVerbatimIn,
  lexicalOverlap,
  verifyClaims,
  MIN_LEXICAL_OVERLAP,
  type CitedChunk,
  type EntailmentJudge,
} from './knowledge-claim.js';

/**
 * P1-GATE-04 — the knowledge-claim gate (ADR-0019).
 *
 * The tests that matter are the ones about *authority*: which outcomes code may
 * reach on its own, and which the judge may reach. A gate where a confident
 * judge can rescue a fabricated citation is not this gate.
 */

const PACK: CitedChunk[] = [
  {
    id: 'chunk-a',
    text: 'The importer retries three times with exponential backoff capped at thirty seconds.',
  },
  {
    id: 'chunk-b',
    text: 'Migrations are applied in order and each one is reversible via a down step.',
  },
  { id: 'chunk-c', text: 'Unrelated prose about invoicing, currencies and tax rounding rules.' },
];

const alwaysEntails: EntailmentJudge = () =>
  Promise.resolve({ entailed: true, contradicted: false, confidence: 0.9 });

describe('decomposeClaim', () => {
  it('splits a compound claim so it cannot pass on its stronger half', () => {
    const parts = decomposeClaim('AC-3 is satisfied and the migration is reversible.');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('AC-3');
    expect(parts[1]).toContain('migration');
  });

  it('splits sentences and semicolons', () => {
    expect(decomposeClaim('First thing. Second thing; third thing.')).toHaveLength(3);
  });

  it('leaves a single claim alone', () => {
    expect(decomposeClaim('The importer retries three times.')).toEqual([
      'The importer retries three times.',
    ]);
  });

  it('does not split an "and" inside a proper name', () => {
    // Over-splitting produces fragments no chunk can support, which turns the
    // gate into noise a reviewer learns to skip.
    expect(decomposeClaim('The Read and Write ports are separate.')).toHaveLength(1);
  });
});

describe('lexicalOverlap', () => {
  it('measures containment of the claim in the chunk, not symmetric similarity', () => {
    const short = lexicalOverlap('the importer retries three times', PACK[0]?.text ?? '');
    expect(short).toBeGreaterThan(0.9);
  });

  it('is near zero for an unrelated chunk', () => {
    expect(lexicalOverlap('the importer retries three times', PACK[2]?.text ?? '')).toBeLessThan(
      MIN_LEXICAL_OVERLAP,
    );
  });
});

describe('isVerbatimIn', () => {
  it('ignores punctuation and case', () => {
    expect(isVerbatimIn('the importer RETRIES three times', PACK[0]?.text ?? '')).toBe(true);
  });

  it('refuses to call a very short phrase verbatim grounding', () => {
    // Otherwise the one deterministic path to "supported" is the easy one to
    // game: cite anything, claim three words that appear in it.
    expect(isVerbatimIn('the importer', PACK[0]?.text ?? '')).toBe(false);
  });
});

describe('verifyClaims — what code decides on its own', () => {
  it('abstains on a claim that cites nothing', async () => {
    const bundle = await verifyClaims([{ claim: 'AC-3 is satisfied.', cited_chunk_ids: [] }], PACK);
    expect(bundle.results[0]?.verdict).toBe('abstain');
    expect(bundle.results[0]?.method).toBe('no-citation');
    expect(bundle.ok).toBe(false);
  });

  it('marks a fabricated citation unsupported, not abstained', async () => {
    const bundle = await verifyClaims(
      [{ claim: 'AC-3 is satisfied by the retry logic.', cited_chunk_ids: ['chunk-zzz'] }],
      PACK,
    );
    // Worse than citing nothing: it asserts grounding that does not exist, and
    // routes to "flag for review" rather than "fetch more context".
    expect(bundle.results[0]?.verdict).toBe('unsupported');
    expect(bundle.results[0]?.method).toBe('citation-not-in-pack');
  });

  it('abstains on a citation with no lexical footing, rather than calling the claim wrong', async () => {
    const bundle = await verifyClaims(
      [{ claim: 'The importer retries three times.', cited_chunk_ids: ['chunk-c'] }],
      PACK,
    );
    // Word counting is not entitled to say a claim is false: a correct claim in
    // different words scores the same as an irrelevant citation.
    expect(bundle.results[0]?.verdict).toBe('abstain');
    expect(bundle.results[0]?.method).toBe('no-lexical-overlap');
  });

  it('affirms a verbatim quotation without any judge', async () => {
    const bundle = await verifyClaims(
      [
        {
          claim: 'Migrations are applied in order',
          cited_chunk_ids: ['chunk-b'],
        },
      ],
      PACK,
    );
    expect(bundle.results[0]?.verdict).toBe('supported');
    expect(bundle.results[0]?.method).toBe('verbatim');
    expect(bundle.ok).toBe(true);
  });

  it('passes a claim list that is empty', async () => {
    const bundle = await verifyClaims([], PACK);
    // Silence needs no grounding; it is the assertion that does.
    expect(bundle.ok).toBe(true);
  });
});

describe('verifyClaims — what only the judge decides', () => {
  // High term overlap with chunk-a, but not a verbatim quotation of it: exactly
  // the band where only an entailment judge can conclude.
  const paraphrase = {
    claim: 'The importer retries with exponential backoff',
    cited_chunk_ids: ['chunk-a'],
  };

  it('abstains rather than passing when no judge is configured', async () => {
    const bundle = await verifyClaims([paraphrase], PACK);
    expect(bundle.results[0]?.verdict).toBe('abstain');
    expect(bundle.results[0]?.method).toBe('no-judge-configured');
    // Not a pass. This is the whole point of abstention being first class.
    expect(bundle.ok).toBe(false);
    expect(bundle.abstained).toHaveLength(1);
  });

  it('lets a judge affirm what code could not', async () => {
    const bundle = await verifyClaims([paraphrase], PACK, alwaysEntails);
    expect(bundle.results[0]?.verdict).toBe('supported');
    expect(bundle.results[0]?.method).toBe('judge');
    expect(bundle.results[0]?.confidence).toBe(0.9);
  });

  it('routes a contradiction to unsupported', async () => {
    const contradicts: EntailmentJudge = () =>
      Promise.resolve({ entailed: false, contradicted: true, confidence: 0.8 });
    const bundle = await verifyClaims([paraphrase], PACK, contradicts);
    expect(bundle.results[0]?.verdict).toBe('unsupported');
  });

  it('abstains when the judge cannot conclude either way', async () => {
    const unsure: EntailmentJudge = () =>
      Promise.resolve({ entailed: false, contradicted: false, confidence: 0.3 });
    const bundle = await verifyClaims([paraphrase], PACK, unsure);
    expect(bundle.results[0]?.verdict).toBe('abstain');
  });

  it('never lets a confident judge rescue a fabricated citation', async () => {
    const bundle = await verifyClaims(
      [{ claim: 'AC-3 is satisfied by the retry logic.', cited_chunk_ids: ['chunk-zzz'] }],
      PACK,
      alwaysEntails,
    );
    expect(bundle.results[0]?.verdict).toBe('unsupported');
    // And it was never asked. A deterministic refusal is not an opinion the
    // judge gets to weigh in on.
    expect(bundle.judgeCalls).toBe(0);
  });

  it('does not spend a judge call on a claim the pre-filter eliminated', async () => {
    const bundle = await verifyClaims(
      [{ claim: 'The importer retries three times.', cited_chunk_ids: ['chunk-c'] }],
      PACK,
      alwaysEntails,
    );
    expect(bundle.judgeCalls).toBe(0);
    expect(bundle.results[0]?.verdict).toBe('abstain');
  });

  it('does not spend a judge call on a verbatim quotation either', async () => {
    const bundle = await verifyClaims(
      [{ claim: 'Migrations are applied in order', cited_chunk_ids: ['chunk-b'] }],
      PACK,
      alwaysEntails,
    );
    expect(bundle.judgeCalls).toBe(0);
  });
});

describe('verifyClaims — decomposition changes the outcome', () => {
  it('fails a compound claim whose second half is not supported', async () => {
    const bundle = await verifyClaims(
      [
        {
          claim: 'Migrations are applied in order and every tax rule is covered by a test.',
          cited_chunk_ids: ['chunk-b'],
        },
      ],
      PACK,
    );
    // Verified as one string, the strong half would have carried the weak one.
    expect(bundle.results).toHaveLength(2);
    expect(bundle.results[0]?.verdict).toBe('supported');
    expect(bundle.results[1]?.verdict).not.toBe('supported');
    expect(bundle.ok).toBe(false);
  });
});

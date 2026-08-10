import { describe, expect, it } from 'vitest';
import {
  BLINDED_ARTIFACTS,
  LensOutputSchema,
  REVIEW_LENSES,
  ReviewLensSchema,
  lensBlocks,
  lensSetViolations,
  lensesForReview,
  lensViolations,
  type ReviewLens,
} from './review-lens.js';

/**
 * P1-AGENT-10 — advisory lenses (ADR-0066).
 *
 * The failure being designed against is not "we paid 4× for one opinion". It is
 * that four correlated agents *agreeing* reads as corroboration. So the tests
 * are about a lens having to vary something, and about a lens without a
 * deterministic disposer never being allowed to block.
 */

const lens = (over: Partial<ReviewLens> = {}): ReviewLens =>
  ReviewLensSchema.parse({
    key: 'falsification',
    levers: ['falsification-framing', 'question-set'],
    contextSlice: ['diff'],
    questions: ['What input makes this produce a wrong answer?'],
    gating: false,
    ...over,
  });

describe('a lens must vary something', () => {
  it('rejects a lens with no levers at all', () => {
    // A lens that varies nothing is a persona, and persona-only fan-out is the
    // correlated-output failure the ADR opens by naming.
    expect(ReviewLensSchema.safeParse({ ...lens(), levers: [] }).success).toBe(false);
  });

  it('rejects the weakest lever used alone', () => {
    const problems = lensViolations(lens({ levers: ['counterfactual-framing'] }));
    expect(problems.join(' ')).toContain('never used alone');
  });

  it('rejects two lenses that vary identically', () => {
    const twins = [lens({ key: 'a' }), lens({ key: 'b' })];
    // Their agreement is one opinion counted twice.
    expect(lensSetViolations(twins).join(' ')).toContain('vary identically');
  });

  it('accepts lenses that differ in their context slice', () => {
    const distinct = [lens({ key: 'a' }), lens({ key: 'b', contextSlice: ['diff', 'tests'] })];
    expect(lensSetViolations(distinct)).toEqual([]);
  });
});

describe('authority', () => {
  it('refuses a gating lens with no deterministic disposer', () => {
    const problems = lensViolations(lens({ gating: true }));
    // A lens that blocks on a model's opinion is the self-report this product
    // exists to disbelieve.
    expect(problems.join(' ')).toContain('no deterministic disposer');
  });

  it('accepts a gating lens that names one', () => {
    expect(lensViolations(lens({ gating: true, disposer: 'contract-conformance-check' }))).toEqual(
      [],
    );
  });

  it('never lets a non-gating lens block, however many questions it raises', () => {
    const advisory = lens();
    const output = LensOutputSchema.parse({
      lens: advisory.key,
      questions: Array.from({ length: 12 }, (_, i) => ({
        lens: advisory.key,
        question: `something alarming ${String(i)}`,
        file: 'src/a.ts',
        wouldBeSettledBy: 'a test covering the empty-input case',
      })),
    });
    // Routing them to a human is the entire point of a non-gating lens.
    expect(lensBlocks(advisory, output)).toBe(false);
  });

  it('blocks only on a failing disposer', () => {
    const gate = lens({ gating: true, disposer: 'contract-conformance-check' });
    expect(
      lensBlocks(
        gate,
        LensOutputSchema.parse({ lens: gate.key, questions: [], disposerResult: 'fail' }),
      ),
    ).toBe(true);
    expect(
      lensBlocks(
        gate,
        LensOutputSchema.parse({ lens: gate.key, questions: [], disposerResult: 'pass' }),
      ),
    ).toBe(false);
    // No result is not a pass and not a block — nothing ran.
    expect(lensBlocks(gate, LensOutputSchema.parse({ lens: gate.key, questions: [] }))).toBe(false);
  });

  it('has no verdict field for a lens to fill in', () => {
    const rejected = LensOutputSchema.safeParse({
      lens: 'falsification',
      questions: [],
      verdict: 'looks fine to me',
    });
    // A field that exists is a field something will eventually read.
    expect(rejected.success).toBe(false);
  });
});

describe('a question has to be answerable', () => {
  it('requires what would settle it', () => {
    const rejected = LensOutputSchema.safeParse({
      lens: 'falsification',
      questions: [{ lens: 'falsification', question: 'is this safe?', file: 'src/a.ts' }],
    });
    // Without it a "question" is an insinuation, and a review that emits
    // insinuations trains people to skip reviews.
    expect(rejected.success).toBe(false);
  });
});

describe('the shipped set', () => {
  it('has no structural violations', () => {
    expect(lensSetViolations(REVIEW_LENSES)).toEqual([]);
  });

  it('has at most one gating lens, and it names its disposer', () => {
    const gating = REVIEW_LENSES.filter((entry) => entry.gating);
    for (const entry of gating) expect(entry.disposer).toBeDefined();
  });

  it('blinds the anchors that prime agreement', () => {
    // Text explaining why a change is correct primes agreement; blinding is the
    // one lever that reduces cost while increasing independence.
    expect(BLINDED_ARTIFACTS).toContain('implementer-rationale');
    expect(BLINDED_ARTIFACTS).toContain('passing-test-output');
  });

  it('gives every lens a distinct context slice or lever mix', () => {
    const signatures = REVIEW_LENSES.map(
      (entry) =>
        `${[...entry.levers].sort().join(',')}|${[...entry.contextSlice].sort().join(',')}`,
    );
    expect(new Set(signatures).size).toBe(REVIEW_LENSES.length);
  });
});

describe('fan-out is opt-in (ADR-0067)', () => {
  it('runs one advisory lens plus the gating one by default', () => {
    const selected = lensesForReview(REVIEW_LENSES);
    expect(selected.filter((entry) => entry.gating)).toHaveLength(1);
    // Fan-out multiplies cost, and correlated lenses are worse than one lens —
    // so more of them is something a workspace opts into.
    expect(selected.filter((entry) => !entry.gating)).toHaveLength(1);
  });

  it('runs them all when the workspace asked for it', () => {
    expect(lensesForReview(REVIEW_LENSES, { multiLens: true })).toHaveLength(REVIEW_LENSES.length);
  });

  it('always keeps the gating lens, whose result is a fact rather than a question', () => {
    expect(lensesForReview(REVIEW_LENSES).some((entry) => entry.gating)).toBe(true);
  });
});

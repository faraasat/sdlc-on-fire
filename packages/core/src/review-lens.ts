import { z } from 'zod';

/**
 * Review lenses, decorrelated by construction (P1-AGENT-10, ADR-0066/0065 §5).
 *
 * The naive version of this is actively harmful. Spawn four subagents on one
 * model over one context, differing only in a persona string, and you get
 * correlated outputs — same weights, same conditioning, same blind spots. The
 * cost is not that you paid 4× for one opinion. It is that **four correlated
 * agents agreeing reads as corroboration**, converting an unexamined blind spot
 * into false confidence.
 *
 * So the design question is not what personality to give a reviewer. It is what
 * to *vary* so its output is genuinely decorrelated from the implementer's. A
 * lens is therefore a tuple of variations over the review input, and a lens that
 * varies nothing is **rejected at registration** rather than run.
 *
 * The second rule is about authority. A lens either carries a deterministic
 * disposer or it is marked non-gating **in data**, and a non-gating lens emits
 * *questions for a human* — never a verdict. A model's opinion dressed as a
 * verdict is the thing this whole product exists to disbelieve, and giving it a
 * confident tone does not change what it is.
 */

/** The decorrelation levers, strongest first (ADR-0066). */
export const DECORRELATION_LEVERS = [
  'evidence-diversity',
  'question-set',
  'falsification-framing',
  'blinding',
  'model-diversity',
  'counterfactual-framing',
] as const;
export const DecorrelationLeverSchema = z.enum(DECORRELATION_LEVERS);
export type DecorrelationLever = z.infer<
  (typeof DECORRELATION_LEVERS)[number] extends never ? never : typeof DecorrelationLeverSchema
>;

export const ReviewLensSchema = z
  .object({
    key: z.string().min(1),
    /**
     * What this lens varies. At least one, checked at registration.
     *
     * A lens that declares none is a persona, and a persona-only lens is the
     * correlated-fan-out failure the ADR opens by naming.
     */
    levers: z.array(DecorrelationLeverSchema).min(1),
    /** The context slice this lens gets. Different input is the strongest lever. */
    contextSlice: z.array(z.string().min(1)).min(1),
    /** The versioned question list. Data, so it is auditable and improvable. */
    questions: z.array(z.string().min(1)).min(1),
    /**
     * The deterministic check that lets this lens *gate*, when it has one.
     *
     * Absent means non-gating, and that is not a soft default — {@link lensViolations}
     * refuses a lens that claims to gate without naming its disposer.
     */
    disposer: z.string().min(1).optional(),
    /**
     * Whether this lens may block. Structural, in data, not inferred from tone.
     *
     * A lens with no disposer cannot be gating whatever this says; the check
     * exists so the contradiction is caught at registration instead of at the
     * moment something is blocked on an opinion.
     */
    gating: z.boolean(),
  })
  .strict();

export type ReviewLens = z.infer<typeof ReviewLensSchema>;

/**
 * Anchors withheld from every lens by default (ADR-0066 lever 4).
 *
 * Text explaining why a change is correct primes agreement. Blinding is the one
 * lever that *reduces* cost while increasing independence, which is why it is
 * the default rather than an option.
 */
export const BLINDED_ARTIFACTS: readonly string[] = [
  'implementer-rationale',
  'implementer-self-assessment',
  'passing-test-output',
];

/** Structural problems with a lens, as lines. */
export function lensViolations(lens: ReviewLens): readonly string[] {
  const problems: string[] = [];

  if (lens.gating && lens.disposer === undefined) {
    problems.push(
      `"${lens.key}" is marked gating with no deterministic disposer — a lens that blocks on a ` +
        "model's opinion is the self-report this product exists to disbelieve (ADR-0040)",
    );
  }

  // Persona-only lenses are the correlated fan-out the ADR opens by naming.
  // Zod already requires one lever; this catches the subtler version — a lens
  // whose only lever is the weakest one, used alone.
  if (lens.levers.length === 1 && lens.levers[0] === 'counterfactual-framing') {
    problems.push(
      `"${lens.key}" varies only by counterfactual framing — the weakest lever, and ADR-0066 says ` +
        'never used alone',
    );
  }

  return problems;
}

/**
 * Whether a set of lenses is actually diverse.
 *
 * Two lenses sharing every lever and every context slice are one lens run
 * twice, and their agreement is not evidence. Checked across the set rather than
 * per lens, because a lens can be individually valid and still add nothing.
 */
export function lensSetViolations(lenses: readonly ReviewLens[]): readonly string[] {
  const problems = lenses.flatMap((lens) => lensViolations(lens));
  const seen = new Map<string, string>();
  for (const lens of lenses) {
    const signature = `${[...lens.levers].sort().join(',')}|${[...lens.contextSlice].sort().join(',')}`;
    const twin = seen.get(signature);
    if (twin !== undefined) {
      problems.push(
        `"${lens.key}" and "${twin}" vary identically — their agreement is one opinion counted twice`,
      );
    }
    seen.set(signature, lens.key);
  }
  return problems;
}

/** What a non-gating lens is allowed to emit. */
export const LensQuestionSchema = z
  .object({
    lens: z.string().min(1),
    question: z.string().min(1),
    /** Where the reader should look. A question with no anchor is not actionable. */
    file: z.string().min(1),
    /**
     * What would settle it.
     *
     * Required. Without it a "question" is an insinuation, and a review that
     * emits insinuations trains people to skip reviews.
     */
    wouldBeSettledBy: z.string().min(1),
  })
  .strict();

export type LensQuestion = z.infer<typeof LensQuestionSchema>;

/**
 * The output contract for a lens pass.
 *
 * A non-gating lens carries `questions` and no verdict field at all — not a
 * verdict it is asked to ignore. A field that exists is a field something will
 * eventually read.
 */
export const LensOutputSchema = z
  .object({
    lens: z.string().min(1),
    questions: z.array(LensQuestionSchema),
    /**
     * Only meaningful for a lens with a disposer, and only ever the disposer's
     * result — never the model's impression of it.
     */
    disposerResult: z.enum(['pass', 'fail']).optional(),
  })
  .strict();

export type LensOutput = z.infer<typeof LensOutputSchema>;

/**
 * Whether a lens pass may block, given what it returned.
 *
 * The only path to `true` is a gating lens whose *deterministic* disposer failed.
 * Questions never block, however many there are and however alarming they sound
 * — routing them to a human is the entire point of a non-gating lens.
 */
export function lensBlocks(lens: ReviewLens, output: LensOutput): boolean {
  if (!lens.gating || lens.disposer === undefined) return false;
  return output.disposerResult === 'fail';
}

/**
 * Which lenses a review actually runs.
 *
 * One by default. Fan-out multiplies cost, and ADR-0066's own argument cuts both
 * ways: correlated lenses are worse than one lens, so more of them is only worth
 * paying for when a workspace has decided it is — the `multi_lens_review`
 * capability (ADR-0067). The gating lens is always included, because it is the
 * only one whose result is a fact rather than a question.
 */
export function lensesForReview(
  lenses: readonly ReviewLens[],
  options: { readonly multiLens?: boolean | undefined } = {},
): readonly ReviewLens[] {
  if (options.multiLens === true) return lenses;
  const gating = lenses.filter((lens) => lens.gating);
  const firstAdvisory = lenses.find((lens) => !lens.gating);
  return firstAdvisory === undefined ? gating : [...gating, firstAdvisory];
}

/** The shipped lenses. Data — adding one is a row, and it must vary something. */
export const REVIEW_LENSES: readonly ReviewLens[] = [
  ReviewLensSchema.parse({
    key: 'contract-conformance',
    levers: ['evidence-diversity', 'question-set', 'blinding'],
    contextSlice: ['diff', 'contracts'],
    questions: [
      'Does any changed signature diverge from the contract it implements?',
      'Does a new field appear in code before it appears in the contract?',
    ],
    // Deterministic: the contract docs are the comparison, not an impression.
    disposer: 'contract-conformance-check',
    gating: true,
  }),
  ReviewLensSchema.parse({
    key: 'falsification',
    levers: ['falsification-framing', 'question-set', 'blinding'],
    contextSlice: ['diff', 'tests'],
    questions: [
      'What input makes this change produce a wrong answer?',
      'Which asserted behaviour has no test that would fail if it broke?',
    ],
    gating: false,
  }),
  ReviewLensSchema.parse({
    key: 'blast-radius',
    levers: ['evidence-diversity', 'question-set'],
    contextSlice: ['diff', 'file-history', 'dependency-surface'],
    questions: [
      'What else reads the thing this changed?',
      'Has this file been involved in a past incident?',
    ],
    gating: false,
  }),
  ReviewLensSchema.parse({
    key: 'requirement-fidelity',
    levers: ['evidence-diversity', 'question-set', 'blinding'],
    contextSlice: ['diff', 'echo-back', 'acceptance-criteria'],
    questions: [
      'Which approved acceptance criterion does this change not address?',
      'Does the change do something the restated understanding did not include?',
    ],
    gating: false,
  }),
];

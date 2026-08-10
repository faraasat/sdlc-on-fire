import { z } from 'zod';

/**
 * The knowledge-claim gate (P1-GATE-04, ADR-0019).
 *
 * The evidence gate already refuses to believe "tests pass" — it runs the
 * command. It had no equivalent skepticism for a claim like "AC-3 is satisfied"
 * or "this matches ADR-0009", which is exactly as unverifiable as the test claim
 * was before evidence gates existed.
 *
 * ADR-0019's pipeline is decompose → cite → verify → abstain, and the shape of
 * the verify step is where this has to be careful. Entailment is not decidable
 * in code, so an LLM judge is the only thing that can affirm a non-verbatim
 * claim — and an LLM in the disposer seat is the one thing ADR-0040 forbids.
 *
 * The resolution is asymmetric authority:
 *
 * - **Deterministic checks can only refuse.** No citation, a citation naming a
 *   chunk that was never in the pack, a claim with no lexical footing in what it
 *   cites — these are decided in code, and no judge can overturn them.
 * - **Only verbatim grounding affirms deterministically.** If the cited chunk
 *   literally contains the claim, that is a fact about two strings.
 * - **Everything else is the judge's, and the judge advises.** Its verdict is
 *   recorded with provenance, and when no judge is configured the claim
 *   *abstains*. It never passes by default.
 *
 * Which makes abstention load-bearing rather than a third enum value: with no
 * judge wired, this gate abstains on most real claims, and the honest reading of
 * that is "nothing verified these" — not "these are fine".
 */

/** A claim as a skill emits it, with the chunks it says ground it. */
export const KnowledgeClaimSchema = z
  .object({
    claim: z.string().min(1),
    /**
     * Chunk ids the generator says support this. Verification runs against
     * *these*, never a fresh retrieval: re-retrieving would test whether support
     * exists somewhere, when the question is whether the generator had it.
     */
    cited_chunk_ids: z.array(z.string().min(1)).default([]),
  })
  .strict();

/** A factual assertion a skill made, tagged with its claimed grounding. */
export type KnowledgeClaim = z.infer<typeof KnowledgeClaimSchema>;

/** A chunk that was actually in the context pack the generator read. */
export interface CitedChunk {
  readonly id: string;
  readonly text: string;
}

/**
 * Why a sub-claim ended up where it did.
 *
 * Recorded per sub-claim because the remediation differs: a fabricated citation
 * needs a human to look at the claim, and a thin one needs more context.
 */
export type ClaimMethod =
  | 'no-citation'
  | 'citation-not-in-pack'
  | 'no-lexical-overlap'
  | 'verbatim'
  | 'judge'
  | 'no-judge-configured';

/**
 * Three outcomes, and the two failing ones route differently (ADR-0019).
 *
 * `unsupported` → block and flag for review: the claim asserts grounding it does
 * not have. `abstain` → block and request more context: nothing concluded.
 * Collapsing them trains a reviewer to treat every gate failure the same way.
 */
export type ClaimVerdict = 'supported' | 'unsupported' | 'abstain';

export interface ClaimResult {
  readonly claim: string;
  readonly citedChunkId: string | null;
  readonly verdict: ClaimVerdict;
  readonly method: ClaimMethod;
  /** 1 for a decided-in-code outcome; the judge's own number when it ruled. */
  readonly confidence: number;
  readonly detail: string;
}

/**
 * The escalation an entailment judge implements.
 *
 * A port, so the gate is testable without a model and so "no judge configured"
 * is a representable state rather than an assumption. It returns a *proposal*:
 * {@link verifyClaims} decides what to do with it, and never lets it overturn a
 * deterministic refusal.
 */
export type EntailmentJudge = (input: {
  readonly claim: string;
  readonly chunk: CitedChunk;
}) => Promise<{ entailed: boolean; contradicted: boolean; confidence: number }>;

/** Below this share of the claim's content words appearing in the chunk, nothing is escalated. */
export const MIN_LEXICAL_OVERLAP = 0.25;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'does',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.\-/\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Share of the claim's content words that appear in the chunk.
 *
 * Containment rather than Jaccard: a long chunk supporting a short claim is the
 * normal case, and Jaccard would score it down for being long.
 */
export function lexicalOverlap(claim: string, chunkText: string): number {
  const words = contentWords(claim);
  if (words.length === 0) return 0;
  const inChunk = new Set(contentWords(chunkText));
  return words.filter((word) => inChunk.has(word)).length / words.length;
}

function normaliseForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether the cited chunk literally contains the claim — the one thing code can affirm. */
export function isVerbatimIn(claim: string, chunkText: string): boolean {
  const needle = normaliseForQuote(claim);
  // A two-word "claim" would match almost any chunk, and calling that verbatim
  // grounding would make the affirming path the easy one to game.
  if (needle.split(' ').length < 4) return false;
  return normaliseForQuote(chunkText).includes(needle);
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

/**
 * Splits a claim into atomic sub-claims (ADR-0019's decompose step).
 *
 * Sentences, then top-level conjunctions. The point is that "AC-3 is satisfied
 * and the migration is reversible" cannot pass on the strength of the half that
 * happens to be cited — a compound claim verified as a unit is verified at its
 * weakest link only by accident.
 *
 * Deliberately conservative: it splits on `;` and a standalone ` and `, not on
 * every clause boundary. Over-splitting produces fragments no chunk can support
 * and turns the gate into noise.
 */
export function decomposeClaim(text: string): string[] {
  return (
    text
      .split(SENTENCE_SPLIT)
      .flatMap((sentence) => sentence.split(/;\s*/))
      // Case-sensitive on purpose. A capitalised word after "and" is usually part
      // of a name — "the Read and Write ports" is one claim, not two — and the
      // `i` flag would have applied to the lookahead as well as to "and",
      // splitting exactly the cases the lookahead exists to protect.
      .flatMap((part) => part.split(/\s+and\s+(?=[a-z0-9`"'@_])/))
      .map((part) => part.trim().replace(/^[,;]\s*/, ''))
      .filter((part) => part.length > 0)
  );
}

/**
 * Verifies one atomic sub-claim against the chunks the generator cited.
 *
 * Order matters and is the whole design: every refusal that can be decided in
 * code is decided before the judge is consulted, so a judge cannot rescue a
 * fabricated citation by being confident about it.
 */
async function verifyOne(
  claim: string,
  claimed: readonly string[],
  pack: ReadonlyMap<string, CitedChunk>,
  judge: EntailmentJudge | undefined,
): Promise<ClaimResult> {
  if (claimed.length === 0) {
    return {
      claim,
      citedChunkId: null,
      verdict: 'abstain',
      method: 'no-citation',
      confidence: 1,
      detail: 'the claim cites nothing, so there is nothing to verify it against',
    };
  }

  const found = claimed.filter((id) => pack.has(id));
  if (found.length === 0) {
    return {
      claim,
      citedChunkId: claimed[0] ?? null,
      verdict: 'unsupported',
      method: 'citation-not-in-pack',
      confidence: 1,
      // Worse than citing nothing: this asserts grounding that does not exist,
      // and a reader skimming the citation would take the claim as checked.
      detail: `cites ${claimed.join(', ')}, none of which was in the context pack`,
    };
  }

  const candidates = found
    .map((id) => pack.get(id) as CitedChunk)
    .map((chunk) => ({ chunk, overlap: lexicalOverlap(claim, chunk.text) }))
    .sort((a, b) => b.overlap - a.overlap);

  const best = candidates[0] as { chunk: CitedChunk; overlap: number };

  const verbatim = candidates.find((candidate) => isVerbatimIn(claim, candidate.chunk.text));
  if (verbatim !== undefined) {
    return {
      claim,
      citedChunkId: verbatim.chunk.id,
      verdict: 'supported',
      method: 'verbatim',
      confidence: 1,
      detail: `the cited chunk contains this claim verbatim`,
    };
  }

  if (best.overlap < MIN_LEXICAL_OVERLAP) {
    return {
      claim,
      citedChunkId: best.chunk.id,
      // Abstain, not unsupported — and the distinction is a limit on what word
      // counting is entitled to say. Low overlap means the citation is probably
      // not about this claim, but a correct claim written in different words
      // scores the same, so "we could not establish this" is as far as the
      // evidence goes. Fabricated citations are the case code *can* call wrong.
      verdict: 'abstain',
      method: 'no-lexical-overlap',
      confidence: 1,
      detail:
        `the best cited chunk shares ${(best.overlap * 100).toFixed(0)}% of the claim's terms ` +
        `(floor ${(MIN_LEXICAL_OVERLAP * 100).toFixed(0)}%) — too little to escalate`,
    };
  }

  if (judge === undefined) {
    return {
      claim,
      citedChunkId: best.chunk.id,
      verdict: 'abstain',
      method: 'no-judge-configured',
      confidence: 0,
      // Not a pass. Entailment beyond a literal quotation needs a judge, and
      // with none configured the honest answer is that nothing checked this.
      detail: 'lexically plausible, but no entailment judge is configured to conclude',
    };
  }

  const ruling = await judge({ claim, chunk: best.chunk });
  if (ruling.contradicted) {
    return {
      claim,
      citedChunkId: best.chunk.id,
      verdict: 'unsupported',
      method: 'judge',
      confidence: ruling.confidence,
      detail: 'the cited chunk contradicts this claim',
    };
  }
  return {
    claim,
    citedChunkId: best.chunk.id,
    verdict: ruling.entailed ? 'supported' : 'abstain',
    method: 'judge',
    confidence: ruling.confidence,
    detail: ruling.entailed
      ? 'the cited chunk entails this claim'
      : 'the judge could not conclude either way',
  };
}

export interface ClaimBundle {
  readonly results: readonly ClaimResult[];
  /** True only when every sub-claim is supported. Abstention is not a pass. */
  readonly ok: boolean;
  /** Block and flag for review. */
  readonly unsupported: readonly ClaimResult[];
  /** Block and request more context. */
  readonly abstained: readonly ClaimResult[];
  /** How many judge calls this cost, so the pre-filter's saving is visible. */
  readonly judgeCalls: number;
}

/**
 * Runs the ADR-0019 pipeline over a skill's claims.
 *
 * `pack` is what the generator could actually see. A claim citing anything
 * outside it is refused here rather than resolved by looking the chunk up
 * elsewhere — a citation to something the generator never read is a fabricated
 * citation whether or not the text exists somewhere.
 */
export async function verifyClaims(
  claims: readonly KnowledgeClaim[],
  pack: readonly CitedChunk[],
  judge?: EntailmentJudge,
): Promise<ClaimBundle> {
  const index = new Map(pack.map((chunk) => [chunk.id, chunk]));
  const results: ClaimResult[] = [];
  let judgeCalls = 0;

  const counting: EntailmentJudge | undefined =
    judge === undefined
      ? undefined
      : async (input) => {
          judgeCalls += 1;
          return await judge(input);
        };

  for (const claim of claims) {
    for (const atomic of decomposeClaim(claim.claim)) {
      results.push(await verifyOne(atomic, claim.cited_chunk_ids, index, counting));
    }
  }

  const unsupported = results.filter((result) => result.verdict === 'unsupported');
  const abstained = results.filter((result) => result.verdict === 'abstain');
  return {
    results,
    // An empty claim list passes: a skill that asserts nothing has nothing to
    // ground. It is the assertion, not the silence, that needs backing.
    ok: unsupported.length === 0 && abstained.length === 0,
    unsupported,
    abstained,
    judgeCalls,
  };
}

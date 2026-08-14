/**
 * The bounded continuous-improvement loop (P2-SKILL-04, ADR-0026).
 *
 * The product never trains anything — that is locked. "Gets better over time"
 * therefore lives entirely at the prompt/skill layer: mine traces for recurring
 * failures, propose a scoped change, validate it against a held-out suite, and
 * **stop**, because the last step is a human's.
 *
 * ADR-0026 calls point 5 "the single most important design decision in this
 * ADR", and the distinction it draws is the whole reason this module exists:
 *
 *   A **self-improving harness** proposes changes to its own prompts and skills
 *   and has a human merge them. **Recursive self-improvement** is the same loop
 *   with the human removed. The difference is one approval step, it is worth
 *   very little as a convention, and it is worth a great deal as a type.
 *
 * So the boundary is structural in three places rather than documented in one:
 *
 * 1. **A proposal cannot reach `approved` without a human.** `approveProposal`
 *    checks `actorKind === 'human'` — the same device as the rescope gate
 *    (`insertion.ts`) and for the same reason: a role can be assigned to a
 *    service account, and `actorKind` cannot.
 * 2. **A proposal cannot touch the machinery that judges it.** Not "should
 *    not" — `PROTECTED_SURFACES` is a list, the check is a path match, and a
 *    proposal that edits the evaluator, the approval boundary, or this file is
 *    rejected before anyone reads it. A loop permitted to improve its own
 *    evaluator optimises the evaluator, which is the reward-hacking failure
 *    ADR-0026's risk register names.
 * 3. **A proposal cannot skip validation.** No held-out run means `proposed`,
 *    not `validated`, and `approveProposal` refuses anything not validated —
 *    so "the mining signal was strong" can never stand in for a regression run
 *    (ADR-0026 point 4).
 *
 * Two subtler rules from the same ADR, both easy to leave out and both the
 * difference between a loop that works and one that looks like it does:
 *
 * **Model tier is part of the validation, not context around it.** The STOP
 * finding is that self-improvement loops *degrade* performance on weaker
 * models, so a change validated on a tier production does not use has not been
 * validated (point 6). The tier is recorded on the run and compared.
 *
 * **Mining that only looks at successes collapses.** ADR-0026 names diversity
 * collapse explicitly: mine only the accepted patterns and the loop converges
 * on safe fixes while never seeing the alternatives that were rejected for
 * unrelated reasons. So a mining run over a single-outcome sample reports that
 * fact instead of its findings.
 */

/**
 * Where a proposal may never reach.
 *
 * Path fragments, matched against every file a proposal would change. Each one
 * is a component whose job is to judge or to gate — the evaluator that scores
 * the loop's output, the boundary that decides who may approve, and the mining
 * and proposal logic itself. A change to any of them is a change to the thing
 * measuring the change.
 *
 * Deliberately a list rather than a heuristic: the boundary that separates a
 * self-improving harness from recursive self-improvement should be readable in
 * full by anyone who wonders where it is.
 */
export const PROTECTED_SURFACES = [
  'improvement.ts',
  'trajectory-eval.ts',
  'low-tier-verify.ts',
  'evaluate-gate.ts',
  'gate-policy',
  'insertion.ts',
  'security-review.ts',
  'role-registry.ts',
] as const;

export const IMPROVEMENT_KINDS = ['prompt-template', 'skill', 'memory-entry'] as const;
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number];

/**
 * The states a proposal moves through.
 *
 * There is no transition from `validated` to `approved` that an automated actor
 * can drive. That absence is the design.
 */
export const IMPROVEMENT_STATES = ['proposed', 'validated', 'rejected', 'approved'] as const;
export type ImprovementState = (typeof IMPROVEMENT_STATES)[number];

export interface ImprovementProposal {
  readonly id: string;
  readonly kind: ImprovementKind;
  /** Which skill or template this changes. */
  readonly target: string;
  /** Repository-relative paths the change would touch. */
  readonly files: readonly string[];
  /** The pattern in the traces that produced it — never a bare assertion. */
  readonly evidence: MinedPattern;
  readonly rationale: string;
}

export interface Approval {
  readonly actorId: string;
  /** `human` or `agent`. A role can be given to a service account; this cannot. */
  readonly actorKind: 'human' | 'agent';
  readonly at: string;
}

/** A held-out regression run, and the tier it ran on. */
export interface ValidationRun {
  readonly suite: string;
  readonly passed: number;
  readonly failed: number;
  /** The model tier the suite was run against. */
  readonly tier: string;
  readonly at: string;
}

export interface ProposalVerdict {
  readonly id: string;
  readonly state: ImprovementState;
  /** Why, in the terms of ADR-0026's numbered points. Never a bare state. */
  readonly reasons: readonly string[];
}

/** Files a proposal would change that it is not allowed to. */
export function protectedFilesTouched(proposal: ImprovementProposal): string[] {
  return proposal.files.filter((file) =>
    PROTECTED_SURFACES.some((surface) => file.includes(surface)),
  );
}

/**
 * A recurring pattern mined from traces.
 *
 * `outcomes` is the set of trace outcomes the pattern was drawn from, and it is
 * carried rather than summarised because the diversity check needs it: a
 * pattern seen only in failures, or only in successes, is a pattern nobody
 * compared against its alternative.
 */
export interface MinedPattern {
  readonly signature: string;
  readonly occurrences: number;
  readonly outcomes: readonly string[];
  readonly examples: readonly string[];
}

/** Below this, a "recurring" pattern is a coincidence with a name. */
export const MIN_OCCURRENCES = 3;

export interface TraceRecord {
  readonly id: string;
  readonly skill: string;
  /** What went wrong, normalised — the thing that recurs. */
  readonly signature: string;
  /** `passed` / `failed` / `rejected` — the run's outcome, as the gate saw it. */
  readonly outcome: string;
}

export interface MiningResult {
  readonly patterns: readonly MinedPattern[];
  /** Populated when the sample cannot support a conclusion. Findings are empty then. */
  readonly refusals: readonly string[];
}

/**
 * Mines traces for recurring patterns.
 *
 * Refuses rather than reports when the sample is single-outcome. ADR-0026 names
 * diversity collapse as a specific risk of this loop: mining only what passed
 * converges on safe fixes and never sees the better alternative that was
 * rejected for an unrelated reason, and mining only what failed produces
 * "patterns" that are simply what the work looks like. Either way the finding
 * is about the sample, not about the system, and reporting it as the latter is
 * the failure.
 */
export function mineTraces(
  traces: readonly TraceRecord[],
  minOccurrences = MIN_OCCURRENCES,
): MiningResult {
  const outcomes = new Set(traces.map((trace) => trace.outcome));
  if (traces.length > 0 && outcomes.size < 2) {
    return {
      patterns: [],
      refusals: [
        `every trace in this sample is "${[...outcomes][0] ?? ''}" — a single-outcome sample ` +
          'produces patterns nobody compared against an alternative (ADR-0026, diversity collapse)',
      ],
    };
  }

  const bySignature = new Map<string, TraceRecord[]>();
  for (const trace of traces) {
    bySignature.set(trace.signature, [...(bySignature.get(trace.signature) ?? []), trace]);
  }

  const patterns = [...bySignature.entries()]
    .filter(([, group]) => group.length >= minOccurrences)
    .map(([signature, group]) => ({
      signature,
      occurrences: group.length,
      outcomes: [...new Set(group.map((trace) => trace.outcome))].sort(),
      examples: group.slice(0, 3).map((trace) => trace.id),
    }))
    .sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature));

  return { patterns, refusals: [] };
}

/**
 * Judges a proposal.
 *
 * Pure, and takes the validation run as an argument rather than performing it —
 * so an approval can never precede the evidence it rests on. Same shape as
 * `evaluateInsertion`, and for the same reason.
 *
 * `productionTier` is required. Omitting it would make the STOP check optional,
 * and an optional check on a loop that edits its own prompts is not one.
 */
export function evaluateProposal(
  proposal: ImprovementProposal,
  validation: ValidationRun | null,
  productionTier: string,
  approvals: readonly Approval[] = [],
): ProposalVerdict {
  const reasons: string[] = [];

  const protectedFiles = protectedFilesTouched(proposal);
  if (protectedFiles.length > 0) {
    // Rejected outright, and never merely "flagged". A loop allowed to edit its
    // own evaluator optimises the evaluator.
    return {
      id: proposal.id,
      state: 'rejected',
      reasons: [
        `touches ${protectedFiles.join(', ')} — a proposal may not change the machinery that ` +
          'judges it, gates it, or produced it (ADR-0026 point 3)',
      ],
    };
  }

  if (proposal.evidence.occurrences < MIN_OCCURRENCES) {
    return {
      id: proposal.id,
      state: 'rejected',
      reasons: [
        `${String(proposal.evidence.occurrences)} occurrence(s) — below ${String(MIN_OCCURRENCES)}, ` +
          'which makes this a coincidence with a name rather than a pattern',
      ],
    };
  }

  if (validation === null) {
    reasons.push(
      'no held-out validation run — the mining signal alone never licenses a change (ADR-0026 point 4)',
    );
    return { id: proposal.id, state: 'proposed', reasons };
  }

  if (validation.failed > 0) {
    return {
      id: proposal.id,
      state: 'rejected',
      reasons: [`${String(validation.failed)} held-out case(s) failed on ${validation.suite}`],
    };
  }

  if (validation.passed === 0) {
    // A suite that ran nothing is not a green suite. Same rule the evidence
    // gate applies to a zero-test verify run.
    return {
      id: proposal.id,
      state: 'rejected',
      reasons: [`${validation.suite} executed 0 cases — an empty run is not a passing one`],
    };
  }

  if (validation.tier !== productionTier) {
    return {
      id: proposal.id,
      state: 'rejected',
      reasons: [
        `validated on tier "${validation.tier}" but production runs "${productionTier}" — ` +
          'improvement loops have been shown to degrade performance on weaker models, so nothing ' +
          'is assumed to carry across a tier change (ADR-0026 point 6)',
      ],
    };
  }

  const human = approvals.find((approval) => approval.actorKind === 'human');
  if (human === undefined) {
    reasons.push(
      approvals.length === 0
        ? 'validated, and waiting for a human to merge it — there is no automatic redeploy (ADR-0026 point 5)'
        : `approved only by ${approvals.map((approval) => approval.actorId).join(', ')}, none of them human — ` +
            'automated gating does not catch reward-hacking against a flawed evaluator, which is the ' +
            'specific thing the human step is for',
    );
    return { id: proposal.id, state: 'validated', reasons };
  }

  return {
    id: proposal.id,
    state: 'approved',
    reasons: [
      `${validation.passed} held-out case(s) passed on ${validation.suite} at tier ${validation.tier}`,
      `approved by ${human.actorId} at ${human.at}`,
    ],
  };
}

export function formatProposalVerdict(verdict: ProposalVerdict): string {
  const mark = verdict.state === 'approved' ? '✓' : verdict.state === 'rejected' ? '✗' : '·';
  return [
    `${mark} ${verdict.id}: ${verdict.state}`,
    ...verdict.reasons.map((reason) => `    ${reason}`),
  ].join('\n');
}

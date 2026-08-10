import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { SkillTier } from '@sdlc-on-fire/core';

/**
 * The verification gate on cheap-tier output (P1-GATE-05, ADR-0028 §4).
 *
 * ADR-0028 routes most subagent volume to the low tier, and the sentence that
 * makes that safe rather than merely cheap is: low-tier output is trusted
 * **only** when it is schema/rubric-verifiable *and actually verified*. The
 * router already resolves a tier. Nothing checked the second half.
 *
 * The failure mode being defended against is specific. A cheap model rarely
 * produces obvious garbage — it produces **well-formed and wrong**: valid JSON
 * with a plausible wrong value, a summary that reads correctly and inverts a
 * conclusion. That output survives every check a human skims for.
 *
 * So the design is not "verify if a verifier is available". It is: **a low-tier
 * task with no declared verification cannot run low at all.** "Verifiable" is a
 * property of the task type, decided in the policy table, not something the
 * caller can supply for whatever it happens to be dispatching.
 */

/** How a task type's cheap output is checked, per subagent-tier-policy.md §3. */
export type VerificationMethod = 'schema' | 'rubric' | 'cross-check';

/**
 * The policy table's third column, as data.
 *
 * A task type absent here is *not* low-tier-eligible. That is the enforcement:
 * adding a cheap route means writing down how its output gets checked, in the
 * same edit, or the route does not exist.
 */
export const LOW_TIER_VERIFICATION: Readonly<Record<string, VerificationMethod>> = {
  'search-triage': 'schema',
  'chunk-tagging': 'schema',
  extraction: 'schema',
  formatting: 'rubric',
  // "rule engine cross-check" in the table: the check is a deterministic rule
  // engine, so it runs on every result rather than a sample. A sampled
  // higher-tier second opinion is the `cross-check` method, and no shipped row
  // uses it yet — a workspace registers its own via `table`.
  'lint-review': 'rubric',
  'query-generation': 'schema',
};

export type RubricCheck = (output: unknown) => readonly string[];

/** A second opinion from a higher tier. Sampled, never run on every call. */
export type CrossCheck = (output: unknown) => Promise<{ agrees: boolean; note: string }>;

export interface LowTierVerifyInput {
  readonly tier: SkillTier;
  /** Key into {@link LOW_TIER_VERIFICATION}. */
  readonly taskType: string;
  readonly output: unknown;
  readonly schema?: z.ZodType | undefined;
  readonly rubric?: RubricCheck | undefined;
  readonly crossCheck?: CrossCheck | undefined;
  /**
   * One repair attempt on a schema failure, per the policy table.
   *
   * One, not a loop: a model that cannot produce the shape on the second try is
   * not going to on the fifth, and an unbounded repair loop turns the cheap tier
   * into the expensive one while still ending in a refusal.
   */
  readonly repair?: ((problems: readonly string[]) => Promise<unknown>) | undefined;
  /** Share of cross-checkable results to actually cross-check. 0 disables it. */
  readonly crossCheckRate?: number | undefined;
  /**
   * The eligibility table to consult. Defaults to {@link LOW_TIER_VERIFICATION}.
   *
   * Overridable so a workspace can register its own cheap task types — but it is
   * still a *table*, so the invariant holds: a method is declared as data
   * somewhere, never supplied ad hoc by whatever is dispatching.
   */
  readonly table?: Readonly<Record<string, VerificationMethod>> | undefined;
}

export interface LowTierVerdict {
  readonly trusted: boolean;
  readonly method: VerificationMethod | 'not-low-tier';
  readonly problems: readonly string[];
  /** The output to use — the repaired value when a repair succeeded. */
  readonly output: unknown;
  readonly repaired: boolean;
  readonly crossChecked: boolean;
}

export const DEFAULT_CROSS_CHECK_RATE = 0.2;

/**
 * Whether this result is in the cross-check sample.
 *
 * Hashed from the output, not randomised. Two properties follow: the same
 * output is always sampled the same way, so a run is reproducible from its
 * artifacts; and nothing here calls `Math.random`, which would make an audit
 * trail that cannot be replayed.
 */
export function inCrossCheckSample(output: unknown, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const digest = createHash('sha256')
    .update(JSON.stringify(output) ?? 'null', 'utf8')
    .digest();
  return digest.readUInt16BE(0) / 0xffff < rate;
}

/**
 * Verifies cheap-tier output before anything is allowed to trust it.
 *
 * Returns a verdict rather than throwing: an unverifiable result is an ordinary
 * outcome the orchestrator handles by re-running at a higher tier, and an
 * exception at that point would take the wave with it.
 */
export async function verifyLowTierOutput(input: LowTierVerifyInput): Promise<LowTierVerdict> {
  // Medium and high tiers have their own gates — the evidence gate for an
  // implementer, cross-model review for a reviewer. This one is about the tier
  // whose whole justification is that its output is checkable.
  if (input.tier !== 'low') {
    return {
      trusted: true,
      method: 'not-low-tier',
      problems: [],
      output: input.output,
      repaired: false,
      crossChecked: false,
    };
  }

  const required = (input.table ?? LOW_TIER_VERIFICATION)[input.taskType];
  if (required === undefined) {
    return {
      trusted: false,
      method: 'schema',
      problems: [
        `task type "${input.taskType}" has no declared verification, so it is not low-tier ` +
          'eligible — add a row to LOW_TIER_VERIFICATION, or route it at medium',
      ],
      output: input.output,
      repaired: false,
      crossChecked: false,
    };
  }

  if (required === 'schema') return await verifyBySchema(input);
  if (required === 'rubric') return verifyByRubric(input);
  return await verifyByCrossCheck(input);
}

async function verifyBySchema(input: LowTierVerifyInput): Promise<LowTierVerdict> {
  if (input.schema === undefined) {
    return refuse(
      'schema',
      input.output,
      `"${input.taskType}" requires schema validation and no schema was supplied — ` +
        'the verification is the reason this ran cheap',
    );
  }

  const first = input.schema.safeParse(input.output);
  if (first.success) {
    return {
      trusted: true,
      method: 'schema',
      problems: [],
      output: first.data,
      repaired: false,
      crossChecked: false,
    };
  }

  const problems = first.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  if (input.repair === undefined) {
    return refuse('schema', input.output, ...problems);
  }

  const repaired = await input.repair(problems);
  const second = input.schema.safeParse(repaired);
  if (!second.success) {
    return refuse(
      'schema',
      input.output,
      ...problems,
      'and the repair pass still did not produce the declared shape',
    );
  }
  return {
    trusted: true,
    method: 'schema',
    problems: [],
    output: second.data,
    repaired: true,
    crossChecked: false,
  };
}

function verifyByRubric(input: LowTierVerifyInput): LowTierVerdict {
  if (input.rubric === undefined) {
    return refuse(
      'rubric',
      input.output,
      `"${input.taskType}" requires a deterministic rubric and none was supplied`,
    );
  }
  const problems = input.rubric(input.output);
  return problems.length === 0
    ? {
        trusted: true,
        method: 'rubric',
        problems: [],
        output: input.output,
        repaired: false,
        crossChecked: false,
      }
    : refuse('rubric', input.output, ...problems);
}

async function verifyByCrossCheck(input: LowTierVerifyInput): Promise<LowTierVerdict> {
  if (input.crossCheck === undefined) {
    return refuse(
      'cross-check',
      input.output,
      `"${input.taskType}" requires a higher-tier cross-check and none was supplied`,
    );
  }

  const rate = input.crossCheckRate ?? DEFAULT_CROSS_CHECK_RATE;
  if (!inCrossCheckSample(input.output, rate)) {
    // Outside the sample. Trusted, and the verdict says it was never checked —
    // a sampled control that reported "verified" for unsampled work would be
    // describing a check it did not run.
    return {
      trusted: true,
      method: 'cross-check',
      problems: [],
      output: input.output,
      repaired: false,
      crossChecked: false,
    };
  }

  const second = await input.crossCheck(input.output);
  return second.agrees
    ? {
        trusted: true,
        method: 'cross-check',
        problems: [],
        output: input.output,
        repaired: false,
        crossChecked: true,
      }
    : {
        trusted: false,
        method: 'cross-check',
        problems: [`the higher-tier cross-check disagreed: ${second.note}`],
        output: input.output,
        repaired: false,
        crossChecked: true,
      };
}

function refuse(
  method: VerificationMethod,
  output: unknown,
  ...problems: string[]
): LowTierVerdict {
  return { trusted: false, method, problems, output, repaired: false, crossChecked: false };
}

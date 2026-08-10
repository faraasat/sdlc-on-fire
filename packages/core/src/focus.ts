import { z } from 'zod';
import { EVIDENCE_KINDS, type EvidenceKind } from './evidence.js';

/**
 * Focus-weighted rigor (P1-LIFE-06, ADR-0054).
 *
 * Not every part of every project deserves equal effort: a payments backend
 * needs correctness and security depth, a marketing site needs UI polish, and
 * forcing either through the other's ceremony is waste that also under-serves
 * the thing that mattered.
 *
 * Three properties keep this from becoming a way to opt out of rigor.
 *
 * **It is data, not judgement.** The focus → required-checks mapping is a table
 * the daemon applies (ADR-0040). "We worked harder on the important part" shows
 * up as *more required evidence*, not as an intention anyone has to believe.
 *
 * **Floors hold.** Security and correctness minimums apply whatever the declared
 * focus. Focus can only ever *add* to the required set — the arithmetic here is
 * a union, and it is that way so a wrong or gamed declaration cannot subtract a
 * check. This is the single most important property in the file, because the
 * obvious implementation (focus picks the required set) makes "focus: ui" a
 * legitimate-looking way to switch the tests off.
 *
 * **Declaring nothing is a real answer.** An undeclared project gets the
 * balanced baseline rather than an inferred profile: guessing a focus from the
 * code would be a model judgement in a decision path, which is exactly what
 * ADR-0040 rules out.
 */

export const FOCUS_DIMENSIONS = [
  'ui',
  'security',
  'data-integrity',
  'performance',
  'api-contract',
  'correctness',
] as const;
export const FocusDimensionSchema = z.enum(FOCUS_DIMENSIONS);
export type FocusDimension = z.infer<typeof FocusDimensionSchema>;

/**
 * A project's declared focus: dimensions with relative weights.
 *
 * Weights are relative and unnormalised on purpose. Forcing them to sum to 1
 * would make raising one dimension silently lower another, which is exactly the
 * "focus is a way to switch things off" failure the floors exist to prevent.
 */
export const FocusProfileSchema = z
  .object({
    weights: z
      .object(
        Object.fromEntries(
          FOCUS_DIMENSIONS.map((dimension) => [dimension, z.number().min(0).max(1).optional()]),
        ) as Record<FocusDimension, z.ZodOptional<z.ZodNumber>>,
      )
      .strict()
      .prefault({}),
  })
  .strict()
  .prefault({});

export type FocusProfile = z.infer<typeof FocusProfileSchema>;

/** Above this, a dimension is "in focus" and its checks become required. */
export const FOCUS_THRESHOLD = 0.5;

/**
 * The checks a dimension demands once it is in focus (ADR-0054, ADR-0044).
 *
 * Illustrative kinds only where v0.1 has no runner: an evidence kind with no
 * producer is *listed* here rather than silently omitted, because the gap is
 * then visible in `sdlc config` instead of being a table that looks complete.
 */
export const FOCUS_CHECKS: Readonly<Record<FocusDimension, readonly EvidenceKind[]>> = {
  ui: ['e2e'],
  security: ['security-scan'],
  'data-integrity': ['test', 'coverage-delta'],
  performance: ['test'],
  'api-contract': ['test', 'typecheck'],
  correctness: ['test', 'mutation-score'],
};

/**
 * The floor: required whatever the focus says.
 *
 * A project that declares `focus: ui` does not thereby stop needing its tests to
 * pass. ADR-0054 names this as the mitigation for a gamed declaration, and it is
 * enforced by construction — see {@link requiredChecksFor}, which unions rather
 * than selects.
 */
export const BASELINE_CHECKS: readonly EvidenceKind[] = ['test', 'typecheck'];

/** Dimensions at or above the threshold, sorted for a stable report. */
export function focusedDimensions(profile: FocusProfile): readonly FocusDimension[] {
  return FOCUS_DIMENSIONS.filter(
    (dimension) => (profile.weights[dimension] ?? 0) >= FOCUS_THRESHOLD,
  );
}

/**
 * Evidence kinds required for a project with this focus.
 *
 * **A union with the baseline, never a selection from it.** Written this way
 * deliberately: the natural-looking alternative — letting the focus decide the
 * required set — turns a declaration the project itself writes into a way to
 * remove checks, and a gate whose required set is chosen by the thing being
 * gated is not a gate.
 */
export function requiredChecksFor(profile: FocusProfile): readonly EvidenceKind[] {
  const required = new Set<EvidenceKind>(BASELINE_CHECKS);
  for (const dimension of focusedDimensions(profile)) {
    for (const kind of FOCUS_CHECKS[dimension]) required.add(kind);
  }
  // Ordered by the canonical kind list so two callers with the same profile get
  // the same array, not just the same set.
  return EVIDENCE_KINDS.filter((kind) => required.has(kind));
}

export interface FocusExplanation {
  readonly dimension: FocusDimension | '(baseline)';
  readonly kind: EvidenceKind;
}

/**
 * Why each check is required — the audit trail for "we hardened the right part".
 *
 * A required set with no attribution cannot be argued with: nobody can tell a
 * check that the baseline demands from one a declaration added, so nobody can
 * tell whether lowering the declaration would remove it.
 */
export function explainRequiredChecks(profile: FocusProfile): readonly FocusExplanation[] {
  const out: FocusExplanation[] = [];
  for (const kind of BASELINE_CHECKS) out.push({ dimension: '(baseline)', kind });
  for (const dimension of focusedDimensions(profile)) {
    for (const kind of FOCUS_CHECKS[dimension]) {
      if (BASELINE_CHECKS.includes(kind)) continue;
      out.push({ dimension, kind });
    }
  }
  return out;
}

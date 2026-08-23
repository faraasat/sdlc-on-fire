/**
 * Making the security-review requirement bite (P6-PAYLOAD-03, FEAT-SEC-006).
 *
 * The requirement was computed and reported and **enforced nowhere**. Found by
 * grepping for callers while building the skill: `requireSecurityReview` is
 * wired into `sdlc risk`, and its two siblings — `withSecurityReview` and
 * `securityReviewSatisfied` — had *only test callers*. Verified on the built
 * binary: a change touching `src/auth.ts` makes `sdlc risk` print
 *
 *     ⚠ security review REQUIRED — touches auth
 *
 * and then exit 0, while `sdlc advance` never asks. The product's whole
 * positioning is "evidence gates, enforced not advisory", and this was the one
 * gate that was advisory.
 *
 * The check lives beside the echo-back one and works the same way: a refusal
 * assembled in `advance`, not a requirement folded into `evaluateGate`. That is
 * deliberate — `advance` calls `evaluateGate` with an empty approvals array, so
 * a role requirement added to the policy there would be unsatisfiable no matter
 * who approved, which is a worse failure than the one being fixed.
 */

import {
  requireSecurityReview,
  securityReviewSatisfied,
  type Approval,
} from '@sdlc-on-fire/evidence';
import { detectRiskSurfaces, type ChangedFile } from '@sdlc-on-fire/core';

export interface SecurityGateOutcome {
  readonly required: boolean;
  readonly surfaces: readonly string[];
  readonly satisfied: boolean;
  /** The refusal to show, or null when nothing blocks. */
  readonly refusal: string | null;
}

export function checkSecurityReview(
  changed: readonly ChangedFile[],
  approvals: readonly Approval[],
  workItemId: string,
): SecurityGateOutcome {
  const findings = detectRiskSurfaces(changed);
  const requirement = requireSecurityReview(findings);
  if (!requirement.required) {
    return { required: false, surfaces: [], satisfied: true, refusal: null };
  }

  const satisfied = securityReviewSatisfied(requirement, approvals);
  const surfaces = [...requirement.surfaces];
  return {
    required: true,
    surfaces,
    satisfied,
    refusal: satisfied
      ? null
      : `security-review: ${workItemId} touches ${surfaces.join(', ')} and has no security sign-off. ` +
        `Approval must come from a human in the ${requirement.roles.join(' or ')} role — an agent ` +
        `approval is refused by the database, not merely discouraged. Run \`sdlc gates approve ` +
        `${workItemId} security --role security\` once somebody has actually reviewed it.`,
  };
}

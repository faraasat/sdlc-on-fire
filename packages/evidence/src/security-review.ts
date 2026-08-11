import { surfacesTouched, type RiskSurface, type SurfaceFinding } from '@sdlc-on-fire/core';
import type { Approval, GatePolicy } from './evaluate-gate.js';

/**
 * The security-review requirement and the auto risk card (P2-SEC-03).
 *
 * `.research/14 §(e)` is explicit that this needs no new machinery: the gate
 * engine already carries `approvals.required_roles` / `min_approvals`, and the
 * insertion engine already auto-creates cards. This module is the part that
 * was missing — the function from "which surfaces did this change touch" to
 * "what does the gate now require".
 *
 * **The requirement is added, never substituted.** A change touching auth still
 * needs its tests, its typecheck, and its build; the security review is one
 * more approval on top. Replacing the base policy would let a high-risk change
 * ship on *fewer* checks than an ordinary one.
 */

/** Who may sign off, in preference order. `security` where the project has it. */
export const SECURITY_REVIEW_ROLES = ['security', 'eng-lead'] as const;

export interface SecurityReviewRequirement {
  readonly required: boolean;
  readonly surfaces: readonly RiskSurface[];
  readonly roles: readonly string[];
  readonly minApprovals: number;
  readonly reason: string;
}

export function requireSecurityReview(
  findings: readonly SurfaceFinding[],
): SecurityReviewRequirement {
  const surfaces = surfacesTouched(findings);
  if (surfaces.length === 0) {
    return {
      required: false,
      surfaces: [],
      roles: [],
      minApprovals: 0,
      reason: 'no high-risk surface touched',
    };
  }

  return {
    required: true,
    surfaces,
    roles: [...SECURITY_REVIEW_ROLES],
    // One human, not two. `.research/14` does not call for a quorum here, and a
    // requirement teams cannot satisfy is a requirement teams disable.
    minApprovals: 1,
    reason: `touches ${surfaces.join(', ')}`,
  };
}

/**
 * Folds the requirement into a gate policy.
 *
 * Roles are unioned rather than replaced: a project that already requires a
 * `data` approval on migrations must not lose it because a security review was
 * added on top.
 */
export function withSecurityReview(
  policy: GatePolicy,
  requirement: SecurityReviewRequirement,
): GatePolicy {
  if (!requirement.required) return policy;

  const roles = [...new Set([...policy.approvals.required_roles, ...requirement.roles])];
  return {
    ...policy,
    approvals: {
      required_roles: roles,
      // Never lowers an existing bar.
      min_approvals: Math.max(policy.approvals.min_approvals, requirement.minApprovals),
    },
  };
}

/**
 * Whether the security review has actually been given.
 *
 * **An agent approval does not count, and cannot be made to count.** This is
 * the invariant the whole product is built on — agents are actors, never
 * approvers — and a security review is the last place to make an exception.
 * The check is `actorKind === 'human'` rather than a role lookup, because a
 * role can be assigned to a service account and `actorKind` cannot be argued
 * with.
 */
export function securityReviewSatisfied(
  requirement: SecurityReviewRequirement,
  approvals: readonly Approval[],
): boolean {
  if (!requirement.required) return true;

  const qualifying = approvals.filter(
    (approval) =>
      approval.actorKind === 'human' &&
      approval.decision === 'approve' &&
      (approval.revokedAt === undefined || approval.revokedAt === null) &&
      typeof approval.roleId === 'string' &&
      requirement.roles.includes(approval.roleId),
  );

  // Distinct people. Two approvals from one reviewer is one review.
  return new Set(qualifying.map((a) => a.actorId)).size >= requirement.minApprovals;
}

export interface RiskCard {
  readonly title: string;
  readonly surface: RiskSurface;
  readonly paths: readonly string[];
  readonly body: string;
}

/**
 * The risk cards a change earns.
 *
 * One per surface, not one per file: "this change touches payments" is the
 * reviewable unit, while nine cards for nine payment files is a backlog nobody
 * reads. `base-idea.md`'s default is that a discovered risk becomes an item
 * rather than a line in a run log, and a card nobody reads is a line in a run
 * log with extra steps.
 *
 * **The card states the surface and the evidence; it does not assess the
 * risk.** Writing "this looks safe" into an auto-generated card would put a
 * conclusion nobody reached in front of the person whose job is to reach it.
 */
export function riskCardsFor(findings: readonly SurfaceFinding[]): readonly RiskCard[] {
  const bySurface = new Map<RiskSurface, SurfaceFinding[]>();
  for (const finding of findings) {
    const existing = bySurface.get(finding.surface);
    if (existing === undefined) bySurface.set(finding.surface, [finding]);
    else existing.push(finding);
  }

  return surfacesTouched(findings).map((surface) => {
    const group = bySurface.get(surface) ?? [];
    const paths = [...new Set(group.map((f) => f.path))];
    return {
      title: `Security review: ${surface}`,
      surface,
      paths,
      body: [
        `This change touches **${surface}**, which requires a security review before it ships.`,
        '',
        'What matched:',
        ...group.map((f) => `- \`${f.path}\` — ${f.evidence}`),
        '',
        'This card was created automatically because the change touched the surface,',
        'not because anything is known to be wrong with it. It records that a review',
        'is owed and by whom — the assessment is the reviewer’s to make.',
      ].join('\n'),
    };
  });
}

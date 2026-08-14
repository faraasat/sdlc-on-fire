import type { Approval, GatePolicy } from './evaluate-gate.js';

/**
 * Approval quorum, self-approval, deadlock and audited overrides (P3-RBAC-03,
 * ADR-0010, contract 03 §4).
 *
 * `evaluateGate` already counted approvals, and counting was not enough. It
 * used `required_roles` as a *filter* and then compared the survivors against
 * `min_approvals`, which means a policy demanding `["eng-lead", "security"]`
 * with `min_approvals: 1` passed on one eng-lead approval and no security
 * review at all — and a policy demanding a role with `min_approvals: 0` passed
 * on nothing. Contract 03 §4 says each named role must **each** have at least
 * one approval; the shipped behaviour said "any one of them, maybe". A security
 * sign-off that a peer's approval satisfies is not a security sign-off.
 *
 * Four properties, and each one is a way a review requirement quietly becomes
 * decorative:
 *
 * **Every required role, separately.** Roles are a set of distinct sign-offs,
 * not a pool. `min_approvals` is an independent floor on top, not a substitute.
 *
 * **The author never approves their own card.** Not a policy toggle. A review
 * requirement satisfied by the person under review is a requirement that
 * changed nothing, and the case is common rather than adversarial — one person
 * moving their own work through a board they set up for a team.
 *
 * **Overlapping policies normalise to one requirement.** Two policies both
 * matching this card and both wanting an eng-lead want *one* eng-lead, not two.
 * Roles union, `min_approvals` takes the maximum, and `overridable_by`
 * intersects — the strictest wins, so a policy that permits no override removes
 * the override path even when an overlapping one allows it. Widening a rule by
 * adding a second matching policy would make the policy set unauditable.
 *
 * **An unsatisfiable rule is reported, not quietly satisfied — except in solo
 * mode, loudly.** GitLab's model auto-satisfies a rule no eligible approver can
 * meet; that is right for one person working alone (the alternative is a board
 * that can never advance) and wrong for a team, where an unsatisfiable rule
 * means the roster is wrong and passing it silently is how a review requirement
 * becomes decorative. So: solo auto-satisfies **and says so, on the verdict**;
 * team deadlocks and names the missing role.
 */

/** How a quorum requirement was met — or not. Never a bare boolean. */
export const QUORUM_GROUNDS = [
  'satisfied',
  'role-unsatisfied',
  'below-min-approvals',
  'deadlocked',
  'auto-satisfied-solo',
] as const;
export type QuorumGround = (typeof QUORUM_GROUNDS)[number];

/** The normalised requirement a set of overlapping policies adds up to. */
export interface QuorumRequirement {
  readonly requiredRoles: readonly string[];
  readonly minApprovals: number;
  readonly overridableBy: readonly string[];
  /** The policies this came from, for the audit trail. */
  readonly from: readonly string[];
}

/** Who could approve, and as what. Read from `memberships`, never guessed. */
export interface EligibleApprover {
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly roles: readonly string[];
}

export interface QuorumContext {
  /** The actor whose work this is. Their own approval never counts. */
  readonly authorActorId: string;
  /** Everyone who could approve on this workspace. */
  readonly eligible: readonly EligibleApprover[];
  /**
   * `solo` auto-satisfies a rule nobody else can meet; `team` deadlocks on it.
   * Not inferred from the roster size — a two-person team where one is on leave
   * is still a team, and guessing would silently drop a review requirement.
   */
  readonly mode: 'solo' | 'team';
}

export interface QuorumFinding {
  readonly ground: QuorumGround;
  readonly role?: string | undefined;
  readonly message: string;
}

export interface QuorumVerdict {
  readonly satisfied: boolean;
  readonly findings: readonly QuorumFinding[];
  /** Roles whose requirement was met by a real approval. */
  readonly met: readonly string[];
  /** Roles auto-satisfied because nobody but the author could meet them. */
  readonly autoSatisfied: readonly string[];
  readonly counted: number;
}

/**
 * Normalises overlapping policies into one requirement.
 *
 * Union on roles, max on the floor, **intersection** on the override path. The
 * asymmetry is deliberate: unioning `overridable_by` would let adding a second
 * matching policy *widen* who can bypass a gate, which is the opposite of what
 * matching a stricter policy should do.
 */
export function normaliseQuorum(policies: readonly GatePolicy[]): QuorumRequirement {
  const roles = new Set<string>();
  let minApprovals = 0;
  let overridableBy: string[] | null = null;

  for (const policy of policies) {
    for (const role of policy.approvals.required_roles) roles.add(role);
    minApprovals = Math.max(minApprovals, policy.approvals.min_approvals);

    const allowed = policy.overridable_by ?? [];
    overridableBy =
      overridableBy === null
        ? [...allowed]
        : overridableBy.filter((role) => allowed.includes(role));
  }

  return {
    requiredRoles: [...roles].sort(),
    minApprovals,
    overridableBy: overridableBy ?? [],
    from: policies.map((policy) => policy.name),
  };
}

/** Approvals that can count at all — before any role or quorum question. */
function qualifying(approvals: readonly Approval[], authorActorId: string): Approval[] {
  return approvals.filter(
    (approval) =>
      // Agents are actors, never approvers (architecture §5). Filtered here as
      // well as by the DB trigger — a bug in one layer must not defeat it.
      approval.actorKind !== 'agent' &&
      approval.decision === 'approve' &&
      (approval.revokedAt === null || approval.revokedAt === undefined) &&
      // The author's own approval, on their own card. Never counts, and this is
      // the ordinary case rather than the adversarial one.
      approval.actorId !== authorActorId,
  );
}

/**
 * Whether the approvals on a gate satisfy the requirement.
 *
 * Pure. Every input — the approvals, the roster, the author, the mode — is
 * passed in, so the verdict can be recomputed from an audit row long after the
 * memberships have changed.
 */
export function evaluateQuorum(
  requirement: QuorumRequirement,
  approvals: readonly Approval[],
  ctx: QuorumContext,
): QuorumVerdict {
  const findings: QuorumFinding[] = [];
  const met: string[] = [];
  const autoSatisfied: string[] = [];

  const counting = qualifying(approvals, ctx.authorActorId);

  for (const role of requirement.requiredRoles) {
    const satisfiedBy = counting.find(
      (approval) => approval.roleId !== null && approval.roleId === role,
    );
    if (satisfiedBy !== undefined) {
      met.push(role);
      continue;
    }

    // Could anybody other than the author have satisfied it?
    const couldHave = ctx.eligible.filter(
      (person) =>
        person.actorKind === 'human' &&
        person.actorId !== ctx.authorActorId &&
        person.roles.includes(role),
    );

    if (couldHave.length > 0) {
      findings.push({
        ground: 'role-unsatisfied',
        role,
        message: `"${role}" has not approved — ${String(couldHave.length)} person(s) could`,
      });
      continue;
    }

    if (ctx.mode === 'solo') {
      // Auto-satisfied, and it is on the verdict rather than swallowed. A rule
      // that quietly evaporates is indistinguishable from one that passed.
      autoSatisfied.push(role);
      findings.push({
        ground: 'auto-satisfied-solo',
        role,
        message: `"${role}" auto-satisfied: nobody but the author holds it, and this workspace is in solo mode`,
      });
      continue;
    }

    findings.push({
      ground: 'deadlocked',
      role,
      message:
        `"${role}" is required and nobody but the author holds it — in a team that means the ` +
        'roster is wrong, and passing it silently is how a review requirement becomes decorative',
    });
  }

  if (counting.length < requirement.minApprovals) {
    findings.push({
      ground: 'below-min-approvals',
      message: `${String(counting.length)}/${String(requirement.minApprovals)} approvals — the floor is independent of the role requirements, not a substitute for them`,
    });
  }

  return {
    // `deadlocked` and `role-unsatisfied` both block; `auto-satisfied-solo` does
    // not, and is the only finding that appears on a passing verdict.
    satisfied: findings.every((finding) => finding.ground === 'auto-satisfied-solo'),
    findings,
    met,
    autoSatisfied,
    counted: counting.length,
  };
}

/* --------------------------------------------------------------- overrides */

export interface OverrideRequest {
  readonly gateId: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly roleKey: string | null;
  readonly reason: string;
}

export interface OverrideAudit {
  readonly event: 'GATE_OVERRIDDEN';
  readonly gateId: string;
  readonly actorId: string;
  readonly roleKey: string;
  readonly reason: string;
  /** The requirement that was bypassed, recorded as it stood at the time. */
  readonly bypassed: QuorumRequirement;
}

export interface OverrideVerdict {
  readonly allowed: boolean;
  readonly refusal?: string | undefined;
  readonly audit?: OverrideAudit | undefined;
}

/**
 * Whether an override may be recorded, and what it writes if so.
 *
 * "Overrides are never silent" (architecture §5) — so this returns the audit row
 * *with* the permission rather than leaving the caller to remember to write one.
 * An override that is allowed and unlogged is the failure this shape prevents by
 * construction: there is no way to get the yes without the record.
 *
 * An empty `overridable_by` is a closed door, not an unset field. Contract 03's
 * strict preset uses `overridable_by: []` to mean *no override path at all*, and
 * reading it as "no restriction" would invert the strictest policy in the set.
 */
export function evaluateOverride(
  requirement: QuorumRequirement,
  request: OverrideRequest,
): OverrideVerdict {
  if (request.actorKind === 'agent') {
    return {
      allowed: false,
      refusal:
        'an agent cannot override a gate — agents are actors, never approvers (architecture §5)',
    };
  }

  if (requirement.overridableBy.length === 0) {
    return {
      allowed: false,
      refusal:
        'this gate has no override path: `overridable_by` is empty, which is a closed door rather ' +
        'than an unset field (contract 03 §4)',
    };
  }

  if (request.roleKey === null || !requirement.overridableBy.includes(request.roleKey)) {
    return {
      allowed: false,
      refusal: `only ${requirement.overridableBy.join(', ')} may override this gate — ${
        request.roleKey ?? 'no role'
      } may not`,
    };
  }

  if (request.reason.trim() === '') {
    return {
      allowed: false,
      refusal:
        'an override needs a stated reason — an unexplained bypass is indistinguishable from a ' +
        'gate that never ran (contract 01, `reason_required_on_override`)',
    };
  }

  return {
    allowed: true,
    audit: {
      event: 'GATE_OVERRIDDEN',
      gateId: request.gateId,
      actorId: request.actorId,
      roleKey: request.roleKey,
      reason: request.reason.trim(),
      // Snapshotted, not referenced. The policy will change; what was bypassed
      // on this day should not change with it.
      bypassed: requirement,
    },
  };
}

export function formatQuorum(requirement: QuorumRequirement, verdict: QuorumVerdict): string {
  const lines = [
    `${verdict.satisfied ? '✓' : '✗'} approvals — ${String(verdict.counted)} counted, ` +
      `${requirement.requiredRoles.length === 0 ? 'no role required' : requirement.requiredRoles.join(', ') + ' required'}` +
      `${requirement.minApprovals > 0 ? `, floor ${String(requirement.minApprovals)}` : ''}`,
  ];
  for (const finding of verdict.findings) {
    lines.push(`  ${finding.ground === 'auto-satisfied-solo' ? '•' : '✗'} ${finding.message}`);
  }
  if (requirement.from.length > 1) {
    lines.push(
      `  Normalised from ${String(requirement.from.length)} overlapping policies: ${requirement.from.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

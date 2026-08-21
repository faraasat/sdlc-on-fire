import type { Approval } from './evaluate-gate.js';
import type { DecisionProvenance, QuorumRequirement, QuorumVerdict } from './quorum.js';

/**
 * Approval revocation (P3-RBAC-08, ADR-0035, FEAT-RBAC-018).
 *
 * ADR-0035 records the gap as "no design exists for what happens if an approver
 * wants to retract a decision before the gated action executes." The schema had
 * `revoked_at`/`revoked_by` from Phase 0 and `countingApprovals` already skipped
 * a revoked row — so the *state* was expressible and nothing could reach it.
 *
 * Three things make this more than a column write, and each is a way a
 * retraction quietly fails to retract:
 *
 * **A revocation is an append, never an erase.** The approval row stays, marked;
 * it is not deleted and its `created_at` is not touched. "This was approved and
 * then withdrawn" and "this was never approved" are different histories, and a
 * delete collapses them into the one that looks better ([ADR-0013](../../../docs/.plan/decisions/ADR-0013-immutable-completed-work.md)).
 *
 * **The gate must actually re-open.** A withdrawn approval that leaves the gate
 * reading `pass` is a retraction in name only — the thing the approver wanted
 * stopped proceeds anyway. So revocation returns the gate transition alongside
 * the row change, and the two are one value: there is no way to take the
 * revocation and forget the re-open.
 *
 * **Who may retract.** The approver may withdraw their own approval — that is
 * the case the ADR names. Anybody else doing it is an *override of a person*,
 * not a correction, and it is held to the override rules: an eligible role and
 * a stated reason. An agent may do neither.
 */

export const REVOCATION_ACTION = 'APPROVAL_REVOKED';

export interface RevocationRequest {
  readonly approvalId: string;
  readonly gateId: string;
  /** The approval being withdrawn, as it stands. */
  readonly approval: Approval;
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly roleKey: string | null;
  readonly reason: string;
  readonly now: string;
}

export interface RevocationAudit {
  readonly event: typeof REVOCATION_ACTION;
  readonly approvalId: string;
  readonly gateId: string;
  /** Who withdrew it, which is not always who gave it. */
  readonly revokedBy: string;
  readonly revokedAt: string;
  readonly reason: string;
  /** Self-withdrawal, or a third party overriding somebody's decision. */
  readonly kind: 'self' | 'third-party';
  /** The rule in force when the original approval was given, if it was captured. */
  readonly originalProvenance?: DecisionProvenance | undefined;
}

export interface RevocationVerdict {
  readonly allowed: boolean;
  readonly refusal?: string | undefined;
  readonly audit?: RevocationAudit | undefined;
  /** The gate's new state. `null` when nothing was allowed to change. */
  readonly reopens?: { readonly gateId: string; readonly result: 'pending' } | undefined;
}

/**
 * Whether an approval may be withdrawn, and everything that must happen if so.
 *
 * The audit row and the gate re-open come back *with* the permission rather than
 * being left to the caller, for the same reason `evaluateOverride` does it: a
 * revocation that is allowed and unlogged, or allowed and un-re-opened, is the
 * failure this shape prevents by construction.
 */
export function evaluateRevocation(
  requirement: QuorumRequirement,
  request: RevocationRequest,
  originalProvenance?: DecisionProvenance,
): RevocationVerdict {
  if (request.actorKind === 'agent') {
    return {
      allowed: false,
      refusal:
        'an agent cannot revoke an approval — agents are actors, never approvers, and withdrawing ' +
        'a human decision is an approval decision (architecture §5)',
    };
  }

  if (request.reason.trim() === '') {
    return {
      allowed: false,
      refusal:
        'a revocation needs a stated reason — an unexplained retraction leaves the next reader ' +
        'unable to tell a correction from a disagreement',
    };
  }

  if (request.approval.revokedAt !== null && request.approval.revokedAt !== undefined) {
    // Not an error worth throwing, but not a no-op either: silently succeeding
    // would write a second audit row for one retraction and make the log
    // disagree with itself about how many times this happened.
    return {
      allowed: false,
      refusal: `approval ${request.approvalId} was already revoked at ${request.approval.revokedAt}`,
    };
  }

  const isSelf = request.approval.actorId === request.actorId;

  if (!isSelf) {
    // Withdrawing somebody else's decision is an override of a person. Held to
    // the override rules rather than to a softer bar of its own — the effect on
    // the gate is identical, and a second, laxer path to the same outcome is
    // how an override policy gets routed around.
    if (requirement.overridableBy.length === 0) {
      return {
        allowed: false,
        refusal:
          'this gate has no override path, so nobody may withdraw another person’s approval on it ' +
          '(`overridable_by` is empty, which is a closed door rather than an unset field)',
      };
    }
    if (request.roleKey === null || !requirement.overridableBy.includes(request.roleKey)) {
      return {
        allowed: false,
        refusal:
          `withdrawing another person's approval needs an override role (${requirement.overridableBy.join(', ')}) — ` +
          `${request.roleKey ?? 'no role'} may not`,
      };
    }
  }

  return {
    allowed: true,
    audit: {
      event: REVOCATION_ACTION,
      approvalId: request.approvalId,
      gateId: request.gateId,
      revokedBy: request.actorId,
      revokedAt: request.now,
      reason: request.reason.trim(),
      kind: isSelf ? 'self' : 'third-party',
      originalProvenance,
    },
    // Unconditional. Whether the gate *still* passes on the remaining approvals
    // is a question for the next evaluation, and answering it here would mean
    // this module deciding a quorum it was not given the inputs for. Re-opening
    // and re-evaluating is correct and cheap; leaving it green on the guess that
    // it would pass anyway is neither.
    reopens: { gateId: request.gateId, result: 'pending' },
  };
}

/**
 * What a gate's verdict becomes once an approval is withdrawn.
 *
 * Separate from {@link evaluateRevocation} because it needs the quorum inputs,
 * and because the answer is genuinely interesting: a gate can survive losing an
 * approval — the floor may still be met, another holder of the role may have
 * approved — and reporting "blocked" when it is not would train people to
 * ignore the notice.
 */
export function revocationImpact(
  before: QuorumVerdict,
  after: QuorumVerdict,
): { readonly stillSatisfied: boolean; readonly summary: string } {
  if (after.satisfied) {
    return {
      stillSatisfied: true,
      summary: before.satisfied
        ? 'the gate still passes on the remaining approvals — re-opened and re-evaluated, not blocked'
        : 'the gate was already not passing; this changes who it is waiting on, not whether',
    };
  }
  const lost = after.findings.filter((finding) => finding.ground !== 'auto-satisfied-solo');
  return {
    stillSatisfied: false,
    summary: `the gate is blocked again: ${lost.map((finding) => finding.message).join('; ')}`,
  };
}

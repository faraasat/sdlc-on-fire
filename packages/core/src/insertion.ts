/**
 * Hard insertion — `add --into` and the rescope approval (P2-INS-01,
 * `.research/11 §1`, contract 02 §5.1).
 *
 * Soft insertion (`capture`, P1-INS-01) is free because it changes nothing:
 * an idea lands in the Inbox and no committed scope moves. Hard insertion is
 * the other tier — putting new work *into a live epic or sprint* — and it is
 * not free, because something already committed is now competing for the same
 * time. Every tool surveyed in `.research/11` lets that happen with no reviewer
 * in the loop: GSD's `--insert` mutates the roadmap directly, BMAD's
 * correct-course edits stories in place. Scrum's answer is a team norm, which
 * is to say an implicit one nobody can point at afterwards.
 *
 * So an inserted item starts at `proposed` and **cannot leave without a human
 * rescope approval**. Two properties make that mean something:
 *
 * 1. **An agent approval does not count and cannot be made to count** — the
 *    check is `actorKind === 'human'`, the same device as the security-review
 *    gate, because a role can be assigned to a service account and `actorKind`
 *    cannot be argued with. An agent proposing work and then approving its own
 *    insertion into a live sprint is the whole failure in one step.
 * 2. **The blast radius is an argument, not a later step.** {@link
 *    evaluateInsertion} cannot be called without one, so there is no ordering
 *    in which somebody approves a rescope before anyone worked out what it
 *    displaces. An approval given without that is a signature, not a decision.
 */

import type { BlastRadius } from './blast-radius.js';

export const INSERTION_STATES = ['proposed', 'approved', 'rejected'] as const;
export type InsertionState = (typeof INSERTION_STATES)[number];

/**
 * Roles whose approval can rescope live work.
 *
 * Deliberately narrow. The point of the gate is that inserting into committed
 * scope is a *planning* decision with a named owner — widening this to every
 * role with write access turns the gate back into the team norm it replaces.
 */
export const RESCOPE_ROLES = ['pm', 'eng-lead'] as const;

export interface RescopeApproval {
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly roleId?: string | null | undefined;
  readonly decision: 'approve' | 'reject';
  readonly revokedAt?: string | null | undefined;
}

export interface InsertionRequest {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  /** The epic or sprint being inserted into. */
  readonly into: string;
  /**
   * Ordering hint: place after this sibling.
   *
   * A hint and nothing more. IDs are sequential and never reused (contract
   * §5.1), so nothing downstream is renumbered to make room — GSD's decimal
   * `3.1` insight, which is that the cost of insertion should not be paid by
   * every item after it.
   */
  readonly after?: string | undefined;
  /** Why this could not wait for the next planning pass. */
  readonly justification?: string | undefined;
}

export interface InsertionVerdict {
  readonly state: InsertionState;
  /** Why it cannot leave `proposed`. Empty once it can. */
  readonly blockers: readonly string[];
  /**
   * Things the approver should have read before deciding, which do not block.
   *
   * A truncated blast radius belongs here rather than in `blockers`: refusing
   * every insertion into a well-connected epic would make the gate something
   * teams route around within a fortnight, and a gate that gets routed around
   * protects nothing. Surfacing it is the honest middle — the approval still
   * happens, but not in ignorance of the fact that the analysis was clipped.
   */
  readonly cautions: readonly string[];
}

/**
 * Whether a human with a rescope role has approved.
 *
 * Distinct approvers, not distinct approvals: two `approve` rows from one
 * person is one decision. Only one is required here — unlike the security gate,
 * a rescope has a single accountable owner, and requiring two would mean
 * routine insertions wait on a quorum.
 */
export function rescopeApproved(approvals: readonly RescopeApproval[]): boolean {
  return approvals.some(
    (approval) =>
      approval.actorKind === 'human' &&
      approval.decision === 'approve' &&
      (approval.revokedAt === undefined || approval.revokedAt === null) &&
      typeof approval.roleId === 'string' &&
      (RESCOPE_ROLES as readonly string[]).includes(approval.roleId),
  );
}

/**
 * Whether the insertion may leave `proposed`, and what the approver was told.
 */
export function evaluateInsertion(
  request: InsertionRequest,
  radius: BlastRadius,
  approvals: readonly RescopeApproval[],
): InsertionVerdict {
  const blockers: string[] = [];
  const cautions: string[] = [];

  // A rejection is a decision, and it outranks a later approval rather than
  // being outvoted by one: if it did not, "keep asking" would be a valid way
  // through the gate, and a gate with a retry loop is a delay, not a gate.
  const rejected = approvals.find(
    (a) =>
      a.decision === 'reject' &&
      a.actorKind === 'human' &&
      (a.revokedAt === undefined || a.revokedAt === null),
  );
  if (rejected !== undefined) {
    return {
      state: 'rejected',
      blockers: [`rescope rejected by ${rejected.actorId}`],
      cautions,
    };
  }

  if (radius.target !== request.into) {
    // Not a formality. A radius computed against a different container is an
    // approval for work nobody analysed, and it would be invisible.
    blockers.push(
      `blast radius was computed for ${radius.target}, not ${request.into} — the analysis does not describe this insertion`,
    );
  }

  if (!rescopeApproved(approvals)) {
    blockers.push(
      `no rescope approval from a human ${RESCOPE_ROLES.join(' or ')} — inserting into ${request.into} moves scope somebody already committed to`,
    );
  }

  const conflicts = radius.ownership.filter((finding) => finding.severity === 'conflict');
  if (conflicts.length > 0) {
    blockers.push(
      `${String(conflicts.length)} file-ownership conflict(s) with in-flight work: ${conflicts.map((c) => c.itemId).join(', ')}`,
    );
  }

  if (radius.truncated) {
    cautions.push(
      `blast radius is a lower bound — ${String(radius.unexplored.length)} item(s) past the hop limit were not analysed: ${radius.unexplored.join(', ')}`,
    );
  }

  for (const finding of radius.ownership.filter((f) => f.severity === 'overlap')) {
    cautions.push(finding.message);
  }

  if (radius.regression.scope === 'full') {
    cautions.push(`this insertion forces full regression — ${radius.regression.reason}`);
  }

  if ((request.justification ?? '').trim() === '') {
    cautions.push(
      'no justification recorded for why this could not wait for the next planning pass',
    );
  }

  return {
    state: blockers.length === 0 ? 'approved' : 'proposed',
    blockers,
    cautions,
  };
}

/**
 * The audit record for an insertion — `kanban/_insertions/INSERT-NNN.md`
 * (contract 06 §3.5, which supersedes contract 02 §6's flat `.sdlc/` path).
 *
 * **Written whether or not the insertion was approved**, and that is the
 * design decision worth defending. Recording only what landed produces an
 * audit trail that answers "what got added to this sprint" and cannot answer
 * "what was asked for and refused" — and the second question is the one being
 * asked when a sprint is being reconstructed a quarter later. A rejected
 * rescope, with its blast radius and its reason, is the most informative row
 * in the file.
 */
export function insertionRecord(
  recordId: string,
  request: InsertionRequest,
  radius: BlastRadius,
  verdict: InsertionVerdict,
  now: string,
): string {
  const lines = [
    '---',
    `id: ${recordId}`,
    'kind: insertion',
    `inserted: ${request.id}`,
    `into: ${request.into}`,
    `state: ${verdict.state}`,
    `recorded_at: ${now}`,
    '---',
    '',
    `# ${recordId} — ${request.kind} ${request.id} into ${request.into}`,
    '',
    `**${request.title}**`,
    '',
    `- State: **${verdict.state}**`,
    `- Placement: ${request.after === undefined ? 'appended' : `after ${request.after}`}`,
    `- Regression: ${radius.regression.scope}`,
    '',
    '## Why now',
    '',
    (request.justification ?? '').trim() === ''
      ? '_Not recorded._'
      : (request.justification ?? '').trim(),
    '',
    '## Blast radius',
    '',
  ];

  if (radius.reached.length === 0) {
    lines.push('_Nothing within the hop limit._');
  } else {
    for (const item of radius.reached) {
      lines.push(`- ${item.id} (${String(item.hop)} hop${item.hop === 1 ? '' : 's'})`);
    }
  }

  if (radius.truncated) {
    lines.push(
      '',
      `> Analysis stopped at the hop limit. Not analysed: ${radius.unexplored.join(', ')}.`,
      '> This radius is a lower bound.',
    );
  }

  if (verdict.blockers.length > 0) {
    lines.push('', '## Blocked by', '');
    for (const blocker of verdict.blockers) lines.push(`- ${blocker}`);
  }

  if (verdict.cautions.length > 0) {
    lines.push('', '## Noted for the approver', '');
    for (const caution of verdict.cautions) lines.push(`- ${caution}`);
  }

  lines.push('');
  return lines.join('\n');
}

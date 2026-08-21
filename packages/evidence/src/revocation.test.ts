import { describe, expect, it } from 'vitest';
import type { Approval } from './evaluate-gate.js';
import {
  decisionProvenance,
  provenanceDrift,
  type QuorumContext,
  type QuorumRequirement,
  type QuorumVerdict,
} from './quorum.js';
import { evaluateRevocation, revocationImpact, type RevocationRequest } from './revocation.js';

/** P3-RBAC-06 (provenance) and P3-RBAC-08 (revocation). */

const requirement = (over: Partial<QuorumRequirement> = {}): QuorumRequirement => ({
  requiredRoles: ['eng-lead'],
  minApprovals: 1,
  overridableBy: ['eng-lead'],
  from: ['standard'],
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  actorId: 'ada',
  actorKind: 'human',
  roleId: 'eng-lead',
  decision: 'approve',
  ...over,
});

const request = (over: Partial<RevocationRequest> = {}): RevocationRequest => ({
  approvalId: '7',
  gateId: '3',
  approval: approval(),
  actorId: 'ada',
  actorKind: 'human',
  roleKey: 'eng-lead',
  reason: 'I misread the diff',
  now: '2026-08-14T12:00:00.000Z',
  ...over,
});

const verdict = (over: Partial<QuorumVerdict> = {}): QuorumVerdict => ({
  satisfied: true,
  findings: [],
  met: ['eng-lead'],
  autoSatisfied: [],
  counted: 1,
  ...over,
});

describe('withdrawing your own approval', () => {
  it('is allowed, and comes back with the audit row attached', () => {
    // The yes and the record are one value. There is no way to take the
    // permission and forget the log.
    const result = evaluateRevocation(requirement(), request());
    expect(result.allowed).toBe(true);
    expect(result.audit?.kind).toBe('self');
    expect(result.audit?.event).toBe('APPROVAL_REVOKED');
  });

  it('re-opens the gate as part of the same answer', () => {
    // A withdrawn approval that leaves the gate reading `pass` is a retraction
    // in name only — the thing the approver wanted stopped proceeds anyway.
    expect(evaluateRevocation(requirement(), request()).reopens).toEqual({
      gateId: '3',
      result: 'pending',
    });
  });

  it('refuses without a stated reason', () => {
    expect(evaluateRevocation(requirement(), request({ reason: '  ' })).refusal).toContain(
      'stated reason',
    );
  });

  it('refuses a second revocation of the same approval', () => {
    // Silently succeeding would write two audit rows for one retraction and
    // make the log disagree with itself about how many times this happened.
    const already = request({ approval: approval({ revokedAt: '2026-08-01T00:00:00Z' }) });
    expect(evaluateRevocation(requirement(), already).allowed).toBe(false);
  });

  it('refuses an agent outright', () => {
    expect(
      evaluateRevocation(requirement(), request({ actorKind: 'agent', actorId: 'bot' })).allowed,
    ).toBe(false);
  });
});

describe('withdrawing somebody else’s approval is an override', () => {
  const other = { actorId: 'grace', approval: approval({ actorId: 'ada' }) };

  it('is allowed to a role on the override path', () => {
    const result = evaluateRevocation(requirement(), request({ ...other, roleKey: 'eng-lead' }));
    expect(result.allowed).toBe(true);
    expect(result.audit?.kind).toBe('third-party');
  });

  it('is refused to a role that is not', () => {
    expect(evaluateRevocation(requirement(), request({ ...other, roleKey: 'qa' })).allowed).toBe(
      false,
    );
  });

  it('is refused entirely when the gate has no override path', () => {
    // Held to the override rules rather than a softer bar of its own: the
    // effect on the gate is identical, and a second laxer path to the same
    // outcome is how an override policy gets routed around.
    const closed = requirement({ overridableBy: [] });
    const result = evaluateRevocation(closed, request({ ...other, roleKey: 'eng-lead' }));
    expect(result.allowed).toBe(false);
    expect(result.refusal).toContain('closed door');
  });

  it('still lets the original approver withdraw on a closed-override gate', () => {
    // Self-withdrawal is a correction, not an override of anybody.
    expect(evaluateRevocation(requirement({ overridableBy: [] }), request()).allowed).toBe(true);
  });

  it('never returns an audit row with a refusal', () => {
    expect(
      evaluateRevocation(requirement(), request({ ...other, roleKey: 'qa' })).audit,
    ).toBeUndefined();
  });
});

describe('what the re-open actually costs', () => {
  it('reports a gate that survives losing one approval', () => {
    // A gate can survive: the floor may still be met, or another holder of the
    // role approved. Reporting "blocked" when it is not trains people to ignore
    // the notice.
    const impact = revocationImpact(verdict(), verdict());
    expect(impact.stillSatisfied).toBe(true);
    expect(impact.summary).toContain('still passes');
  });

  it('names what is missing when it does not survive', () => {
    const after = verdict({
      satisfied: false,
      findings: [
        { ground: 'role-unsatisfied', role: 'eng-lead', message: '"eng-lead" has not approved' },
      ],
      met: [],
      counted: 0,
    });
    const impact = revocationImpact(verdict(), after);
    expect(impact.stillSatisfied).toBe(false);
    expect(impact.summary).toContain('eng-lead');
  });

  it('distinguishes a gate that was already blocked', () => {
    const before = verdict({ satisfied: false });
    expect(revocationImpact(before, verdict()).summary).toContain('who it is waiting on');
  });
});

describe('decision provenance (P3-RBAC-06)', () => {
  const ctx: QuorumContext = {
    authorActorId: 'ada',
    eligible: [{ actorId: 'ada', actorKind: 'human', roles: ['eng-lead'] }],
    mode: 'solo',
  };

  it('captures the rule by value, not by reference', () => {
    // The policy row is expected to move; a reference that follows it is a
    // record of the present pretending to be a record of the past.
    const captured = decisionProvenance(requirement(), verdict(), ctx, 'abc1234');
    expect(captured.requirement.requiredRoles).toEqual(['eng-lead']);
    expect(captured.mode).toBe('solo');
    expect(captured.roster).toEqual([{ actorId: 'ada', roles: ['eng-lead'] }]);
    expect(captured.atCommit).toBe('abc1234');
  });

  it('keeps the verdict alongside the rule', () => {
    // The rule that applied and what it concluded. Either alone leaves the
    // other to be re-derived.
    expect(decisionProvenance(requirement(), verdict(), ctx).verdict.met).toEqual(['eng-lead']);
  });

  it('notices a role that is required now and was not then', () => {
    const captured = decisionProvenance(requirement(), verdict(), ctx);
    const drift = provenanceDrift(
      captured,
      requirement({ requiredRoles: ['eng-lead', 'security'] }),
    );
    expect(drift.join(' ')).toContain('"security" is required now');
  });

  it('notices a role that was required then and is not now', () => {
    const captured = decisionProvenance(
      requirement({ requiredRoles: ['eng-lead', 'qa'] }),
      verdict(),
      ctx,
    );
    expect(provenanceDrift(captured, requirement()).join(' ')).toContain('"qa" was required');
  });

  it('notices a moved floor and a changed override path', () => {
    const captured = decisionProvenance(requirement(), verdict(), ctx);
    const drift = provenanceDrift(captured, requirement({ minApprovals: 3, overridableBy: [] }));
    expect(drift.join(' ')).toContain('floor moved 1 → 3');
    expect(drift.join(' ')).toContain('override path');
  });

  it('reports no drift against an unchanged policy', () => {
    const captured = decisionProvenance(requirement(), verdict(), ctx);
    expect(provenanceDrift(captured, requirement())).toEqual([]);
  });

  it('carries the original provenance onto the revocation audit', () => {
    // So the record of the withdrawal explains what was withdrawn *under*.
    const captured = decisionProvenance(requirement(), verdict(), ctx);
    const result = evaluateRevocation(requirement(), request(), captured);
    expect(result.audit?.originalProvenance?.requirement.requiredRoles).toEqual(['eng-lead']);
  });
});

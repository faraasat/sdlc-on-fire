import { describe, expect, it } from 'vitest';
import { GatePolicySchema, type Approval, type GatePolicy } from './evaluate-gate.js';
import {
  evaluateOverride,
  evaluateQuorum,
  formatQuorum,
  normaliseQuorum,
  type EligibleApprover,
  type QuorumContext,
  type QuorumRequirement,
} from './quorum.js';

/** P3-RBAC-03 — quorum, self-approval, deadlock, audited overrides. */

const policy = (over: Partial<GatePolicy> = {}): GatePolicy =>
  GatePolicySchema.parse({ name: 'p', ...over });

const approval = (over: Partial<Approval> = {}): Approval => ({
  actorId: 'reviewer',
  actorKind: 'human',
  roleId: 'eng-lead',
  decision: 'approve',
  ...over,
});

const person = (id: string, roles: string[]): EligibleApprover => ({
  actorId: id,
  actorKind: 'human',
  roles,
});

const ctx = (over: Partial<QuorumContext> = {}): QuorumContext => ({
  authorActorId: 'author',
  eligible: [person('author', ['eng-lead']), person('reviewer', ['eng-lead', 'security'])],
  mode: 'team',
  ...over,
});

const requirement = (over: Partial<QuorumRequirement> = {}): QuorumRequirement => ({
  requiredRoles: [],
  minApprovals: 0,
  overridableBy: [],
  from: ['p'],
  ...over,
});

describe('every required role, separately', () => {
  it('refuses when one of two named roles has not approved', () => {
    // The shipped bug: `required_roles` filtered the approvals and the
    // survivors were counted against `min_approvals`, so one eng-lead approval
    // satisfied a policy that also demanded a security review.
    const verdict = evaluateQuorum(
      requirement({ requiredRoles: ['eng-lead', 'security'], minApprovals: 1 }),
      [approval()],
      ctx(),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.findings[0]?.role).toBe('security');
  });

  it('passes once each named role has approved', () => {
    const verdict = evaluateQuorum(
      requirement({ requiredRoles: ['eng-lead', 'security'] }),
      [approval(), approval({ actorId: 'reviewer', roleId: 'security' })],
      ctx(),
    );
    expect(verdict.satisfied).toBe(true);
    expect([...verdict.met].sort()).toEqual(['eng-lead', 'security']);
  });

  it('refuses a named role with a floor of zero', () => {
    // The other half of the same bug: a floor of 0 made the role requirement
    // unreachable, so the policy passed on no approvals whatsoever.
    expect(
      evaluateQuorum(requirement({ requiredRoles: ['security'], minApprovals: 0 }), [], ctx())
        .satisfied,
    ).toBe(false);
  });

  it('treats the floor as independent of the roles', () => {
    const verdict = evaluateQuorum(
      requirement({ requiredRoles: ['eng-lead'], minApprovals: 2 }),
      [approval()],
      ctx(),
    );
    expect(verdict.met).toEqual(['eng-lead']);
    expect(verdict.findings.some((f) => f.ground === 'below-min-approvals')).toBe(true);
    expect(verdict.satisfied).toBe(false);
  });
});

describe('the author never approves their own card', () => {
  it('does not count the author’s own approval toward a role', () => {
    // Not adversarial — the ordinary case is one person moving their own work
    // through a board they set up for a team.
    const verdict = evaluateQuorum(
      requirement({ requiredRoles: ['eng-lead'] }),
      [approval({ actorId: 'author' })],
      ctx(),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.counted).toBe(0);
  });

  it('does not count it toward the floor either', () => {
    expect(
      evaluateQuorum(requirement({ minApprovals: 1 }), [approval({ actorId: 'author' })], ctx())
        .counted,
    ).toBe(0);
  });

  it('still counts somebody else holding the same role', () => {
    expect(
      evaluateQuorum(
        requirement({ requiredRoles: ['eng-lead'] }),
        [approval({ actorId: 'author' }), approval({ actorId: 'reviewer' })],
        ctx(),
      ).satisfied,
    ).toBe(true);
  });

  it('never counts an agent, whatever role it carries', () => {
    expect(
      evaluateQuorum(
        requirement({ requiredRoles: ['eng-lead'] }),
        [approval({ actorId: 'bot', actorKind: 'agent' })],
        ctx(),
      ).satisfied,
    ).toBe(false);
  });

  it('ignores a revoked approval', () => {
    expect(
      evaluateQuorum(
        requirement({ requiredRoles: ['eng-lead'] }),
        [approval({ revokedAt: '2026-08-01T00:00:00Z' })],
        ctx(),
      ).satisfied,
    ).toBe(false);
  });

  it('ignores a request-changes decision', () => {
    expect(
      evaluateQuorum(
        requirement({ requiredRoles: ['eng-lead'] }),
        [approval({ decision: 'request-changes' })],
        ctx(),
      ).satisfied,
    ).toBe(false);
  });
});

describe('unsatisfiable rules: solo auto-satisfies, a team deadlocks', () => {
  const onlyMe = ctx({ eligible: [person('author', ['eng-lead'])] });

  it('auto-satisfies in solo mode, and says so on the verdict', () => {
    // A rule that quietly evaporates is indistinguishable from one that passed.
    const verdict = evaluateQuorum(requirement({ requiredRoles: ['eng-lead'] }), [], {
      ...onlyMe,
      mode: 'solo',
    });
    expect(verdict.satisfied).toBe(true);
    expect(verdict.autoSatisfied).toEqual(['eng-lead']);
    expect(verdict.findings[0]?.message).toContain('solo mode');
  });

  it('deadlocks in team mode rather than passing', () => {
    const verdict = evaluateQuorum(requirement({ requiredRoles: ['eng-lead'] }), [], onlyMe);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.findings[0]?.ground).toBe('deadlocked');
    expect(verdict.findings[0]?.message).toContain('roster is wrong');
  });

  it('does not auto-satisfy in solo mode when somebody else could approve', () => {
    // Solo mode is a declared mode, not a licence. If the roster has another
    // holder, the rule is satisfiable and stays required.
    const verdict = evaluateQuorum(
      requirement({ requiredRoles: ['security'] }),
      [],
      ctx({ mode: 'solo' }),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.findings[0]?.ground).toBe('role-unsatisfied');
  });

  it('does not treat an agent on the roster as an eligible approver', () => {
    const verdict = evaluateQuorum(requirement({ requiredRoles: ['eng-lead'] }), [], {
      authorActorId: 'author',
      eligible: [person('author', []), { actorId: 'bot', actorKind: 'agent', roles: ['eng-lead'] }],
      mode: 'team',
    });
    expect(verdict.findings[0]?.ground).toBe('deadlocked');
  });

  it('still applies the floor in solo mode', () => {
    // Auto-satisfying a role nobody holds does not manufacture an approval.
    expect(
      evaluateQuorum(requirement({ requiredRoles: ['eng-lead'], minApprovals: 1 }), [], {
        ...onlyMe,
        mode: 'solo',
      }).satisfied,
    ).toBe(false);
  });
});

describe('overlapping policies normalise to one requirement', () => {
  it('unions the roles and takes the highest floor', () => {
    const merged = normaliseQuorum([
      policy({ name: 'a', approvals: { required_roles: ['eng-lead'], min_approvals: 1 } }),
      policy({ name: 'b', approvals: { required_roles: ['security'], min_approvals: 2 } }),
    ]);
    expect(merged.requiredRoles).toEqual(['eng-lead', 'security']);
    expect(merged.minApprovals).toBe(2);
  });

  it('wants one eng-lead, not two, when both policies name the same role', () => {
    const merged = normaliseQuorum([
      policy({ name: 'a', approvals: { required_roles: ['eng-lead'], min_approvals: 1 } }),
      policy({ name: 'b', approvals: { required_roles: ['eng-lead'], min_approvals: 1 } }),
    ]);
    expect(merged.requiredRoles).toEqual(['eng-lead']);
    expect(evaluateQuorum(merged, [approval({ actorId: 'reviewer' })], ctx()).satisfied).toBe(true);
  });

  it('intersects the override path so the strictest policy wins', () => {
    // Unioning would let *adding* a matching policy widen who can bypass a
    // gate, which is the opposite of what matching a stricter policy means.
    const merged = normaliseQuorum([
      policy({ name: 'a', overridable_by: ['eng-lead'] }),
      policy({ name: 'b', overridable_by: [] }),
    ]);
    expect(merged.overridableBy).toEqual([]);
  });

  it('records which policies it came from', () => {
    expect(normaliseQuorum([policy({ name: 'a' }), policy({ name: 'b' })]).from).toEqual([
      'a',
      'b',
    ]);
  });

  it('is empty and satisfied for no policies at all', () => {
    const merged = normaliseQuorum([]);
    expect(merged.requiredRoles).toEqual([]);
    expect(evaluateQuorum(merged, [], ctx()).satisfied).toBe(true);
  });
});

describe('overrides are never silent', () => {
  const open = requirement({ requiredRoles: ['security'], overridableBy: ['eng-lead'] });

  it('permits one and hands back the audit row with it', () => {
    // The yes and the record are the same value. There is no way to take the
    // permission and forget the log.
    const verdict = evaluateOverride(open, {
      gateId: '7',
      actorId: 'lead',
      actorKind: 'human',
      roleKey: 'eng-lead',
      reason: 'security is out; shipping the hotfix under my name',
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.audit?.event).toBe('GATE_OVERRIDDEN');
    expect(verdict.audit?.reason).toContain('hotfix');
  });

  it('snapshots what was bypassed rather than pointing at it', () => {
    const verdict = evaluateOverride(open, {
      gateId: '7',
      actorId: 'lead',
      actorKind: 'human',
      roleKey: 'eng-lead',
      reason: 'r',
    });
    // The policy will change; what was bypassed on this day should not change
    // with it.
    expect(verdict.audit?.bypassed.requiredRoles).toEqual(['security']);
  });

  it('refuses without a reason', () => {
    expect(
      evaluateOverride(open, {
        gateId: '7',
        actorId: 'lead',
        actorKind: 'human',
        roleKey: 'eng-lead',
        reason: '   ',
      }).refusal,
    ).toContain('stated reason');
  });

  it('refuses a role outside overridable_by', () => {
    expect(
      evaluateOverride(open, {
        gateId: '7',
        actorId: 'x',
        actorKind: 'human',
        roleKey: 'qa',
        reason: 'r',
      }).allowed,
    ).toBe(false);
  });

  it('treats an empty overridable_by as a closed door, not an unset field', () => {
    // The strict preset uses `overridable_by: []` to mean no override path at
    // all; reading it as "no restriction" would invert the strictest policy.
    const verdict = evaluateOverride(requirement(), {
      gateId: '7',
      actorId: 'lead',
      actorKind: 'human',
      roleKey: 'eng-lead',
      reason: 'r',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toContain('closed door');
  });

  it('refuses an agent outright', () => {
    expect(
      evaluateOverride(open, {
        gateId: '7',
        actorId: 'bot',
        actorKind: 'agent',
        roleKey: 'eng-lead',
        reason: 'r',
      }).allowed,
    ).toBe(false);
  });

  it('never returns an audit row with a refusal', () => {
    const refused = evaluateOverride(open, {
      gateId: '7',
      actorId: 'x',
      actorKind: 'human',
      roleKey: null,
      reason: 'r',
    });
    expect(refused.audit).toBeUndefined();
  });
});

describe('formatting', () => {
  it('names the overlapping policies it normalised', () => {
    const merged = normaliseQuorum([policy({ name: 'a' }), policy({ name: 'b' })]);
    expect(formatQuorum(merged, evaluateQuorum(merged, [], ctx()))).toContain('overlapping');
  });

  it('reads as a pass with the solo note still visible', () => {
    const merged = requirement({ requiredRoles: ['eng-lead'] });
    const verdict = evaluateQuorum(merged, [], {
      authorActorId: 'author',
      eligible: [person('author', [])],
      mode: 'solo',
    });
    const text = formatQuorum(merged, verdict);
    expect(text.startsWith('✓')).toBe(true);
    expect(text).toContain('auto-satisfied');
  });
});

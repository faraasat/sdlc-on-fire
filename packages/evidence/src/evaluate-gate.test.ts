import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import {
  countingApprovals,
  defaultV01Policy,
  evaluateGate,
  GatePolicySchema,
  type Approval,
  type GateContext,
  type GatePolicy,
} from './evaluate-gate.js';

const HEAD = 'a'.repeat(40);
const ctx: GateContext = { currentHeadSha: HEAD, now: new Date('2026-08-10T00:00:00.000Z') };

function envelope(over: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  return {
    kind: 'test',
    producer: 'daemon',
    git_sha: HEAD,
    env: { tool_versions: {}, os: 'darwin' },
    content_hash: 'b'.repeat(64),
    confidence: 0.95,
    produced_at: '2026-08-09T00:00:00.000Z',
    payload: { ok: true },
    ...over,
  };
}

const policy = defaultV01Policy();
const allThree = [
  envelope({ kind: 'test' }),
  envelope({ kind: 'typecheck' }),
  envelope({ kind: 'build' }),
];

describe('three-way outcome', () => {
  it('passes when every required kind is present and ok', () => {
    const verdict = evaluateGate(policy, allThree, [], ctx);
    expect(verdict).toMatchObject({ pass: true, missing: [], failures: [], abstained: [] });
  });

  it('reports a never-run check as missing, not failing', () => {
    // "Run the check" and "fix the code" are different remediations.
    const verdict = evaluateGate(policy, [envelope({ kind: 'test' })], [], ctx);
    expect(verdict.missing).toEqual(['typecheck', 'build']);
    expect(verdict.failures).toEqual([]);
    expect(verdict.pass).toBe(false);
  });

  it('reports a failing check as a failure, not missing', () => {
    const verdict = evaluateGate(
      policy,
      [
        envelope({ kind: 'test', payload: { ok: false } }),
        envelope({ kind: 'typecheck' }),
        envelope({ kind: 'build' }),
      ],
      [],
      ctx,
    );
    expect(verdict.failures).toEqual(['test failing']);
    expect(verdict.missing).toEqual([]);
  });
});

describe('agent-claim is structurally excluded', () => {
  it('cannot satisfy a requirement', () => {
    // Not a policy toggle — no policy can opt into trusting it.
    const verdict = evaluateGate(
      policy,
      allThree.map((e) => ({ ...e, producer: 'agent-claim' as const })),
      [],
      ctx,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.missing).toEqual(['test', 'typecheck', 'build']);
  });

  it('is ignored even when it claims success alongside a real failure', () => {
    const verdict = evaluateGate(
      GatePolicySchema.parse({ name: 'p', evidence: [{ kind: 'test' }] }),
      [
        envelope({ payload: { ok: false }, produced_at: '2026-08-09T00:00:00.000Z' }),
        envelope({
          producer: 'agent-claim',
          payload: { ok: true },
          produced_at: '2026-08-09T12:00:00.000Z',
        }),
      ],
      [],
      ctx,
    );
    expect(verdict.failures).toEqual(['test failing']);
  });
});

describe('staleness re-check', () => {
  it('ignores evidence from another commit', () => {
    const verdict = evaluateGate(
      policy,
      allThree.map((e) => ({ ...e, git_sha: 'c'.repeat(40) })),
      [],
      ctx,
    );
    expect(verdict.missing).toEqual(['test', 'typecheck', 'build']);
  });

  it('ignores clean-tree evidence when the tree is now dirty', () => {
    const dirty = { ...ctx, currentDirtyTreeHash: 'd'.repeat(64) };
    expect(evaluateGate(policy, allThree, [], dirty).pass).toBe(false);
  });

  it('accepts evidence matching the same dirty tree', () => {
    const dirty = { ...ctx, currentDirtyTreeHash: 'd'.repeat(64) };
    const matched = allThree.map((e) => ({ ...e, dirty_tree_hash: 'd'.repeat(64) }));
    expect(evaluateGate(policy, matched, [], dirty).pass).toBe(true);
  });
});

describe('freshness', () => {
  it('treats an expired envelope as missing when require_fresh is set', () => {
    const p = GatePolicySchema.parse({
      name: 'p',
      evidence: [{ kind: 'test', require_fresh: true }],
    });
    const expired = envelope({ expires_at: '2026-08-09T12:00:00.000Z' });
    expect(evaluateGate(p, [expired], [], ctx).missing).toEqual(['test']);
  });

  it('accepts an expired envelope when freshness is not required', () => {
    const p = GatePolicySchema.parse({ name: 'p', evidence: [{ kind: 'test' }] });
    expect(
      evaluateGate(p, [envelope({ expires_at: '2026-08-09T12:00:00.000Z' })], [], ctx).pass,
    ).toBe(true);
  });
});

describe('most recent wins', () => {
  it('judges on the latest qualifying envelope', () => {
    const p = GatePolicySchema.parse({ name: 'p', evidence: [{ kind: 'test' }] });
    const verdict = evaluateGate(
      p,
      [
        envelope({ payload: { ok: false }, produced_at: '2026-08-08T00:00:00.000Z' }),
        envelope({ payload: { ok: true }, produced_at: '2026-08-09T00:00:00.000Z' }),
      ],
      [],
      ctx,
    );
    expect(verdict.pass).toBe(true);
  });
});

describe('approvals', () => {
  const p = GatePolicySchema.parse({ name: 'p', approvals: { min_approvals: 1 } });
  const human: Approval = { actorId: 'u1', actorKind: 'human', decision: 'approve' };

  it('counts a human approval', () => {
    expect(evaluateGate(p, [], [human], ctx).pass).toBe(true);
  });

  it('never counts an agent approval', () => {
    // Agents are actors, never approvers (architecture §5).
    const agent: Approval = { actorId: 'a1', actorKind: 'agent', decision: 'approve' };
    expect(evaluateGate(p, [], [agent], ctx).pass).toBe(false);
    expect(countingApprovals([agent], p)).toEqual([]);
  });

  it('ignores a revoked approval', () => {
    expect(
      evaluateGate(p, [], [{ ...human, revokedAt: '2026-08-09T00:00:00.000Z' }], ctx).pass,
    ).toBe(false);
  });

  it('ignores request-changes', () => {
    expect(evaluateGate(p, [], [{ ...human, decision: 'request-changes' }], ctx).pass).toBe(false);
  });

  it('requires the right role when the policy names one', () => {
    const roled = GatePolicySchema.parse({
      name: 'p',
      approvals: { min_approvals: 1, required_roles: ['maintainer'] },
    });
    expect(evaluateGate(roled, [], [human], ctx).pass).toBe(false);
    expect(evaluateGate(roled, [], [{ ...human, roleId: 'maintainer' }], ctx).pass).toBe(true);
  });
});

describe('purity', () => {
  it('returns the same verdict for the same inputs', () => {
    expect(evaluateGate(policy, allThree, [], ctx)).toEqual(
      evaluateGate(policy, allThree, [], ctx),
    );
  });

  it('does not mutate its arguments', () => {
    const snapshot = JSON.stringify(allThree);
    evaluateGate(policy, allThree, [], ctx);
    expect(JSON.stringify(allThree)).toBe(snapshot);
  });
});

describe('knowledge-claim outcomes stay separate (P1-GATE-04, ADR-0019)', () => {
  const claimPolicy = GatePolicySchema.parse({
    name: 'claims',
    evidence: [{ kind: 'knowledge-claim', required: true }],
  });

  const bundle = (over: { unsupported?: unknown[]; abstained?: unknown[] }): EvidenceEnvelope =>
    envelope({
      kind: 'knowledge-claim',
      payload: {
        ok: (over.unsupported ?? []).length === 0 && (over.abstained ?? []).length === 0,
        unsupported: over.unsupported ?? [],
        abstained: over.abstained ?? [],
      },
    });

  it('passes when every claim is grounded', () => {
    expect(evaluateGate(claimPolicy, [bundle({})], [], ctx)).toMatchObject({ pass: true });
  });

  it('routes an unsupported claim to failures — flag for review', () => {
    const verdict = evaluateGate(claimPolicy, [bundle({ unsupported: [{}] })], [], ctx);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.abstained).toHaveLength(0);
    expect(verdict.pass).toBe(false);
  });

  it('routes an abstention to abstained — request more context', () => {
    const verdict = evaluateGate(claimPolicy, [bundle({ abstained: [{}] })], [], ctx);
    // Two failing modes needing different human responses. Merged, a reviewer
    // learns to treat every claim-gate result the same way.
    expect(verdict.abstained).toHaveLength(1);
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.pass).toBe(false);
  });

  it('reports both when both happened', () => {
    const verdict = evaluateGate(
      claimPolicy,
      [bundle({ unsupported: [{}], abstained: [{}, {}] })],
      [],
      ctx,
    );
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.abstained).toHaveLength(1);
  });

  it('still refuses an agent-claim bundle', () => {
    const verdict = evaluateGate(
      claimPolicy,
      [envelope({ kind: 'knowledge-claim', producer: 'agent-claim', payload: { ok: true } })],
      [],
      ctx,
    );
    // The gate exists because agents cannot verify their own claims; an
    // agent-authored verification of an agent's claims is the same problem.
    expect(verdict.missing).toContain('knowledge-claim');
  });
});

describe('every required role must approve, not any one of them (P3-RBAC-03)', () => {
  const withRoles = (roles: string[], min: number): GatePolicy =>
    GatePolicySchema.parse({
      name: 'roles',
      approvals: { required_roles: roles, min_approvals: min },
    });

  const approve = (roleId: string): Approval => ({
    actorId: `who-${roleId}`,
    actorKind: 'human',
    roleId,
    decision: 'approve',
  });

  const ctx = { currentHeadSha: 'sha', now: new Date('2026-08-14T00:00:00Z') };

  it('blocks when a second named role has not approved', () => {
    // `required_roles` used to be a *filter*: the survivors were counted against
    // `min_approvals`, so one eng-lead approval satisfied a policy that also
    // demanded a security review. A security sign-off a peer can satisfy is not
    // a security sign-off.
    const verdict = evaluateGate(
      withRoles(['eng-lead', 'security'], 1),
      [],
      [approve('eng-lead')],
      ctx,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.missing).toContain('approval from security');
  });

  it('blocks a named role even when the floor is zero', () => {
    const verdict = evaluateGate(withRoles(['security'], 0), [], [], ctx);
    expect(verdict.pass).toBe(false);
    expect(verdict.missing).toContain('approval from security');
  });

  it('passes once each named role has approved', () => {
    const verdict = evaluateGate(
      withRoles(['eng-lead', 'security'], 1),
      [],
      [approve('eng-lead'), approve('security')],
      ctx,
    );
    expect(verdict.pass).toBe(true);
  });

  it('still applies the floor on top of the roles', () => {
    const verdict = evaluateGate(withRoles(['eng-lead'], 2), [], [approve('eng-lead')], ctx);
    expect(verdict.missing).toContain('approvals (1/2)');
  });

  it('leaves overridable_by closed when a policy omits it', () => {
    // Empty means no override path at all (contract 03 §4); reading an omitted
    // field as unrestricted would invert the strictest policy in the set.
    expect(GatePolicySchema.parse({ name: 'p' }).overridable_by).toEqual([]);
  });
});

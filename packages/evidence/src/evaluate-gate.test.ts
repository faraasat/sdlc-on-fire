import type { EvidenceEnvelope } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import {
  countingApprovals,
  defaultV01Policy,
  evaluateGate,
  GatePolicySchema,
  type Approval,
  type GateContext,
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

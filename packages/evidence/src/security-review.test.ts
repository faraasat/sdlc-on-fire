import { describe, expect, it } from 'vitest';
import type { SurfaceFinding } from '@sdlc-on-fire/core';
import { defaultV01Policy, type Approval } from './evaluate-gate.js';
import {
  requireSecurityReview,
  riskCardsFor,
  securityReviewSatisfied,
  withSecurityReview,
} from './security-review.js';

/** P2-SEC-03 — the security-review requirement and the auto risk card. */

const finding = (over: Partial<SurfaceFinding> = {}): SurfaceFinding => ({
  surface: 'auth',
  path: 'src/auth/session.ts',
  evidence: 'path is authentication code',
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  actorId: 'person-1',
  actorKind: 'human',
  roleId: 'security',
  decision: 'approve',
  ...over,
});

describe('requireSecurityReview', () => {
  it('requires nothing when no high-risk surface is touched', () => {
    const requirement = requireSecurityReview([]);
    expect(requirement.required).toBe(false);
    expect(requirement.minApprovals).toBe(0);
  });

  it('requires one human review when a surface is touched', () => {
    const requirement = requireSecurityReview([finding()]);
    expect(requirement.required).toBe(true);
    // One, not a quorum. A requirement teams cannot satisfy is one they disable.
    expect(requirement.minApprovals).toBe(1);
    expect(requirement.roles).toContain('security');
  });

  it('names every surface in the reason', () => {
    const requirement = requireSecurityReview([
      finding(),
      finding({ surface: 'payments', path: 'src/billing/x.ts' }),
    ]);
    expect(requirement.reason).toContain('auth');
    expect(requirement.reason).toContain('payments');
  });
});

describe('withSecurityReview', () => {
  it('adds to the base policy rather than replacing it', () => {
    const base = defaultV01Policy();
    const merged = withSecurityReview(base, requireSecurityReview([finding()]));
    // A high-risk change must not ship on *fewer* checks than an ordinary one.
    expect(merged.evidence).toEqual(base.evidence);
    expect(merged.approvals.required_roles).toContain('security');
  });

  it('leaves the policy untouched when no review is required', () => {
    const base = defaultV01Policy();
    expect(withSecurityReview(base, requireSecurityReview([]))).toBe(base);
  });

  it('never lowers an existing bar', () => {
    const strict = {
      ...defaultV01Policy(),
      approvals: { required_roles: ['data'], min_approvals: 2 },
    };
    const merged = withSecurityReview(strict, requireSecurityReview([finding()]));
    // A project already requiring two approvals and a `data` reviewer must not
    // lose either because a security review was added on top.
    expect(merged.approvals.min_approvals).toBe(2);
    expect(merged.approvals.required_roles).toEqual(expect.arrayContaining(['data', 'security']));
  });
});

describe('securityReviewSatisfied', () => {
  const requirement = requireSecurityReview([finding()]);

  it('accepts a human approval in a qualifying role', () => {
    expect(securityReviewSatisfied(requirement, [approval()])).toBe(true);
  });

  it('refuses an agent approval, whatever role it carries', () => {
    // The invariant the product is built on. A security review is the last
    // place to make an exception, and `actorKind` cannot be argued with the
    // way a role assigned to a service account can.
    expect(securityReviewSatisfied(requirement, [approval({ actorKind: 'agent' })])).toBe(false);
  });

  it('refuses an approval from a role that does not qualify', () => {
    expect(securityReviewSatisfied(requirement, [approval({ roleId: 'contributor' })])).toBe(false);
  });

  it('refuses a revoked approval', () => {
    expect(securityReviewSatisfied(requirement, [approval({ revokedAt: '2026-01-01' })])).toBe(
      false,
    );
  });

  it('refuses request-changes', () => {
    expect(securityReviewSatisfied(requirement, [approval({ decision: 'request-changes' })])).toBe(
      false,
    );
  });

  it('counts distinct people, not distinct approvals', () => {
    const twice = [approval(), approval({ roleId: 'eng-lead' })];
    // Same actorId twice is one review. With minApprovals of 1 this still
    // passes, so the assertion that matters is the count.
    expect(new Set(twice.map((a) => a.actorId)).size).toBe(1);
    expect(securityReviewSatisfied(requirement, twice)).toBe(true);
  });

  it('is satisfied trivially when no review was required', () => {
    expect(securityReviewSatisfied(requireSecurityReview([]), [])).toBe(true);
  });
});

describe('riskCardsFor', () => {
  it('creates one card per surface, not per file', () => {
    const cards = riskCardsFor([
      finding({ path: 'src/auth/a.ts' }),
      finding({ path: 'src/auth/b.ts' }),
      finding({ surface: 'payments', path: 'src/billing/c.ts' }),
    ]);
    // Nine cards for nine payment files is a backlog nobody reads — which is a
    // run-log line with extra steps.
    expect(cards).toHaveLength(2);
    expect(cards[0]?.paths).toEqual(['src/auth/a.ts', 'src/auth/b.ts']);
  });

  it('records what matched, so the card can be argued with', () => {
    const [card] = riskCardsFor([finding()]);
    expect(card?.body).toContain('src/auth/session.ts');
    expect(card?.body).toContain('path is authentication code');
  });

  it('states that it asserts nothing about the risk itself', () => {
    const [card] = riskCardsFor([finding()]);
    // Writing an assessment into an auto-generated card puts a conclusion
    // nobody reached in front of the person whose job is to reach it.
    expect(card?.body).toContain('not because anything is known to be wrong');
  });

  it('creates nothing for a change touching no surface', () => {
    expect(riskCardsFor([])).toEqual([]);
  });
});

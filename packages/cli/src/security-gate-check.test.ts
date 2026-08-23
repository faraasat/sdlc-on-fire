import { describe, expect, it } from 'vitest';
import { checkSecurityReview } from './security-gate-check.js';
import type { Approval } from '@sdlc-on-fire/evidence';
import type { ChangedFile } from '@sdlc-on-fire/core';

const auth: ChangedFile[] = [{ path: 'src/auth.ts', addedContent: 'const token = 1;' }];
const boring: ChangedFile[] = [{ path: 'src/format.ts', addedContent: 'const x = 1;' }];

const approval = (over: Partial<Approval> = {}): Approval => ({
  actorId: 'human-1',
  actorKind: 'human',
  roleId: 'security',
  decision: 'approve',
  ...over,
});

describe('the security-review requirement actually blocks', () => {
  it('refuses a high-risk change with no sign-off', () => {
    // Until P6-PAYLOAD-03 the requirement was computed, printed by `sdlc risk`,
    // and enforced nowhere — `withSecurityReview` and `securityReviewSatisfied`
    // had only test callers. "Enforced not advisory" is the product's whole
    // positioning and this was the gate that was advisory.
    const outcome = checkSecurityReview(auth, [], 'FEAT-1');
    expect(outcome.required).toBe(true);
    expect(outcome.satisfied).toBe(false);
    expect(outcome.refusal).toContain('touches auth');
  });

  it('says who may approve and how, rather than only that it is blocked', () => {
    const outcome = checkSecurityReview(auth, [], 'FEAT-1');
    expect(outcome.refusal).toContain('security');
    expect(outcome.refusal).toContain('sdlc gates approve');
  });

  it('passes a change that touches no tracked surface', () => {
    const outcome = checkSecurityReview(boring, [], 'FEAT-1');
    expect(outcome.required).toBe(false);
    expect(outcome.refusal).toBeNull();
  });

  it('passes once a human in the right role has approved', () => {
    const outcome = checkSecurityReview(auth, [approval()], 'FEAT-1');
    expect(outcome.satisfied).toBe(true);
    expect(outcome.refusal).toBeNull();
  });

  it('accepts eng-lead as well as security', () => {
    const outcome = checkSecurityReview(auth, [approval({ roleId: 'eng-lead' })], 'FEAT-1');
    expect(outcome.satisfied).toBe(true);
  });
});

describe('what does not count as a security sign-off', () => {
  it('an agent approval', () => {
    // The `approvals` trigger refuses this at the database level (ADR-0010).
    // Checking here too means the application agrees with the database rather
    // than offering a button the database will reject.
    const outcome = checkSecurityReview(auth, [approval({ actorKind: 'agent' })], 'FEAT-1');
    expect(outcome.satisfied).toBe(false);
  });

  it('an approval from an unrelated role', () => {
    const outcome = checkSecurityReview(auth, [approval({ roleId: 'pm' })], 'FEAT-1');
    expect(outcome.satisfied).toBe(false);
  });

  it('an approval with no role at all', () => {
    const outcome = checkSecurityReview(auth, [approval({ roleId: null })], 'FEAT-1');
    expect(outcome.satisfied).toBe(false);
  });

  it('a revoked approval', () => {
    const outcome = checkSecurityReview(
      auth,
      [approval({ revokedAt: '2026-08-23T10:00:00Z' })],
      'FEAT-1',
    );
    expect(outcome.satisfied).toBe(false);
  });

  it('a request-changes decision', () => {
    const outcome = checkSecurityReview(
      auth,
      [approval({ decision: 'request-changes' })],
      'FEAT-1',
    );
    expect(outcome.satisfied).toBe(false);
  });

  it('the same person approving twice', () => {
    // Two approvals from one reviewer is one review.
    const outcome = checkSecurityReview(auth, [approval(), approval()], 'FEAT-1');
    expect(outcome.satisfied).toBe(true); // minApprovals is 1 — but see below
    const both = checkSecurityReview(
      auth,
      [approval(), approval({ actorId: 'human-2' })],
      'FEAT-1',
    );
    expect(both.satisfied).toBe(true);
  });
});

describe('every surface it names is one it actually found', () => {
  it('reports the surface, not a guess', () => {
    const outcome = checkSecurityReview(auth, [], 'FEAT-1');
    expect(outcome.surfaces).toContain('auth');
  });

  it('reports no surfaces when there are none', () => {
    expect(checkSecurityReview(boring, [], 'FEAT-1').surfaces).toEqual([]);
  });
});

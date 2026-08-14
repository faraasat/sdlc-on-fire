import { describe, expect, it } from 'vitest';
import { AUTHOR_ROLES } from './comment-effect.js';
import { RESCOPE_ROLES } from './insertion.js';
import {
  capability,
  DEFAULT_ROLE_PERMISSIONS,
  HUMAN_ONLY_ACTIONS,
  PERMISSION_KEYS,
  formatCapability,
  roleTableViolations,
  ROLE_KEYS,
  type CapabilityInput,
} from './capability.js';

/**
 * P3-RBAC-01 — the precedence, and the three ways a check stops checking.
 *
 * The first block is the one the contract was ambiguous about, and it is the
 * one worth reading: under the other parenthesisation a role permission
 * bypasses a blocking gate entirely, which is the difference between a gate and
 * a suggestion.
 */

const input = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  actor: { id: 'a1', kind: 'human', displayName: 'Ada' },
  action: 'advance',
  cardId: 'FEAT-001',
  memberships: [{ actorId: 'a1', roleKey: 'eng-lead' }],
  rolePermissions: { 'eng-lead': ['advance', 'approve'] },
  humanOnlyActions: ['approve'],
  now: '2026-08-14T00:00:00.000Z',
  ...overrides,
});

describe('the precedence', () => {
  it('grants on a role permission when nothing is blocking', () => {
    const verdict = capability(input());
    expect(verdict.granted).toBe(true);
    expect(verdict.ground).toBe('role-permission');
  });

  it('refuses a role permission against a blocking gate', () => {
    // The whole ambiguity. `role_permission ∨ (relationship ∧ ¬gate)` would
    // grant this — and a gate only ever blocks somebody who could otherwise
    // act, so a permission that outranks it blocks nobody.
    const verdict = capability(
      input({ blockingGates: [{ cardId: 'FEAT-001', gate: 'review', blocks: ['advance'] }] }),
    );
    expect(verdict.granted).toBe(false);
    expect(verdict.ground).toBe('blocked-by-gate');
  });

  it('refuses a relationship grant against a blocking gate too', () => {
    const verdict = capability(
      input({
        memberships: [],
        relationshipGrants: [
          { actorId: 'a1', cardId: 'FEAT-001', action: 'advance', relationship: 'assignee' },
        ],
        blockingGates: [{ cardId: 'FEAT-001', gate: 'review', blocks: [] }],
      }),
    );
    expect(verdict.ground).toBe('blocked-by-gate');
  });

  it('grants on a relationship when no role does', () => {
    const verdict = capability(
      input({
        memberships: [],
        relationshipGrants: [
          { actorId: 'a1', cardId: 'FEAT-001', action: 'advance', relationship: 'assignee' },
        ],
      }),
    );
    expect(verdict.granted).toBe(true);
    expect(verdict.ground).toBe('relationship-grant');
  });

  it('ignores a gate blocking a different card', () => {
    expect(
      capability(input({ blockingGates: [{ cardId: 'FEAT-002', gate: 'review', blocks: [] }] }))
        .granted,
    ).toBe(true);
  });

  it('ignores a gate blocking a different action', () => {
    expect(
      capability(input({ blockingGates: [{ cardId: 'FEAT-001', gate: 'x', blocks: ['merge'] }] }))
        .granted,
    ).toBe(true);
  });

  it('treats an empty block list as blocking the whole card', () => {
    expect(
      capability(input({ blockingGates: [{ cardId: 'FEAT-001', gate: 'x', blocks: [] }] })).granted,
    ).toBe(false);
  });
});

describe('expiry (ADR-0035)', () => {
  it('refuses an expired membership', () => {
    // A check that reads the row without reading the date turns a temporary
    // grant into a permanent one, and nothing looks wrong.
    const verdict = capability(
      input({
        memberships: [
          { actorId: 'a1', roleKey: 'eng-lead', expiresAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(verdict.granted).toBe(false);
    expect(verdict.ground).toBe('expired-membership');
  });

  it('says expired rather than absent, because they ask for different work', () => {
    const verdict = capability(
      input({
        memberships: [
          { actorId: 'a1', roleKey: 'eng-lead', expiresAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(verdict.because).toContain('expired');
    expect(verdict.ground).not.toBe('no-grant');
  });

  it('honours a membership that has not expired yet', () => {
    expect(
      capability(
        input({
          memberships: [
            { actorId: 'a1', roleKey: 'eng-lead', expiresAt: '2027-01-01T00:00:00.000Z' },
          ],
        }),
      ).granted,
    ).toBe(true);
  });

  it('treats an unreadable expiry as expired', () => {
    // A grant whose end date nobody can read is not one anybody should rely on.
    expect(
      capability(
        input({ memberships: [{ actorId: 'a1', roleKey: 'eng-lead', expiresAt: 'soon' }] }),
      ).granted,
    ).toBe(false);
  });

  it('expires a relationship grant as well', () => {
    expect(
      capability(
        input({
          memberships: [],
          relationshipGrants: [
            {
              actorId: 'a1',
              cardId: 'FEAT-001',
              action: 'advance',
              relationship: 'assignee',
              expiresAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      ).granted,
    ).toBe(false);
  });
});

describe('agents are actors, never approvers', () => {
  it('refuses a human-only action to an agent that has the role', () => {
    // The structural disposer is a database trigger; this exists so the two
    // layers agree rather than a UI offering a button the database refuses.
    const verdict = capability(
      input({
        actor: { id: 'a1', kind: 'agent', displayName: 'claude-code' },
        action: 'approve',
      }),
    );
    expect(verdict.granted).toBe(false);
    expect(verdict.ground).toBe('agent-cannot-approve');
  });

  it('lets an agent take an action that is not human-only', () => {
    expect(
      capability(input({ actor: { id: 'a1', kind: 'agent', displayName: 'claude-code' } })).granted,
    ).toBe(true);
  });

  it('checks the invariant before anything else', () => {
    // Not last. An agent refused for a missing grant would be granted the day
    // somebody adds the role, and nothing would flag the change.
    const verdict = capability(
      input({
        actor: { id: 'a1', kind: 'agent', displayName: 'bot' },
        action: 'approve',
        memberships: [],
      }),
    );
    expect(verdict.ground).toBe('agent-cannot-approve');
  });
});

describe('the decision carries its ground', () => {
  it('names the role that granted it', () => {
    expect(capability(input()).because).toContain('eng-lead');
  });

  it('names the gate that refused it', () => {
    const verdict = capability(
      input({ blockingGates: [{ cardId: 'FEAT-001', gate: 'security-review', blocks: [] }] }),
    );
    expect(verdict.because).toContain('security-review');
  });

  it('reads as a sentence', () => {
    expect(formatCapability(input(), capability(input()))).toContain('Ada may "advance"');
  });

  it('refuses when nobody granted anything', () => {
    const verdict = capability(input({ memberships: [], rolePermissions: {} }));
    expect(verdict.ground).toBe('no-grant');
  });

  it('ignores another actor’s membership', () => {
    expect(
      capability(input({ memberships: [{ actorId: 'someone-else', roleKey: 'eng-lead' }] })).ground,
    ).toBe('no-grant');
  });
});

describe('the role cap', () => {
  it('accepts the eight ADR-0010 roles', () => {
    expect(roleTableViolations([...ROLE_KEYS])).toEqual([]);
    expect(ROLE_KEYS).toHaveLength(8);
  });

  it('flags a role outside the capped set', () => {
    // A row explosion is a modeling error, not a feature request — this is not
    // ABAC and was deliberately not built as it.
    expect(roleTableViolations([...ROLE_KEYS, 'release-manager']).join(' ')).toContain(
      'release-manager',
    );
  });

  it('flags a duplicate key', () => {
    expect(roleTableViolations(['pm', 'pm']).join(' ')).toContain('duplicate');
  });
});

describe('the seeded policy is one table, not several', () => {
  it('grants every role only permissions from the vocabulary', () => {
    for (const [role, granted] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        expect(PERMISSION_KEYS, `${role} → ${permission}`).toContain(permission);
      }
    }
  });

  it('covers all eight roles', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it('gives rescope to exactly the roles insertion.ts already rescopes for', () => {
    // Two tables that disagree about who may change committed scope means one of
    // them is wrong and neither knows it.
    const holders = ROLE_KEYS.filter((role) => DEFAULT_ROLE_PERMISSIONS[role].includes('rescope'));
    expect([...holders].sort()).toEqual([...RESCOPE_ROLES].sort());
  });

  it('gives a stakeholder nothing that gates', () => {
    // The comment dispatch says a stakeholder can be heard and cannot block.
    // If this table let them approve, the product would answer that question
    // two different ways depending on which surface asked.
    expect(DEFAULT_ROLE_PERMISSIONS.stakeholder).toEqual(['comment']);
  });

  it('marks as human-only exactly the actions that decide rather than do', () => {
    expect([...HUMAN_ONLY_ACTIONS].sort()).toEqual(['approve', 'override', 'reopen', 'rescope']);
    for (const action of HUMAN_ONLY_ACTIONS) expect(PERMISSION_KEYS).toContain(action);
  });

  it('uses the same role vocabulary as the comment dispatch', () => {
    // These were two lists spelling two of the eight names differently, which
    // was invisible until `roles` had rows in it.
    expect([...AUTHOR_ROLES]).toEqual([...ROLE_KEYS]);
  });

  it('refuses every human-only action to an agent, whatever its roles', () => {
    for (const action of HUMAN_ONLY_ACTIONS) {
      const verdict = capability(
        input({
          actor: { id: 'a1', kind: 'agent', displayName: 'bot' },
          action,
          memberships: [{ actorId: 'a1', roleKey: 'eng-lead' }],
          rolePermissions: DEFAULT_ROLE_PERMISSIONS,
          humanOnlyActions: HUMAN_ONLY_ACTIONS,
        }),
      );
      expect(verdict.granted, action).toBe(false);
      expect(verdict.ground, action).toBe('agent-cannot-approve');
    }
  });

  it('still lets an agent claim and advance under the real table', () => {
    for (const action of ['advance', 'claim'] as const) {
      expect(
        capability(
          input({
            actor: { id: 'a1', kind: 'agent', displayName: 'bot' },
            action,
            memberships: [{ actorId: 'a1', roleKey: 'sr-eng' }],
            rolePermissions: DEFAULT_ROLE_PERMISSIONS,
            humanOnlyActions: HUMAN_ONLY_ACTIONS,
          }),
        ).granted,
        action,
      ).toBe(true);
    }
  });
});

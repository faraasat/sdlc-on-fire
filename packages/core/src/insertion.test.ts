import { describe, expect, it } from 'vitest';
import { computeBlastRadius, type WorkItemNode } from './blast-radius.js';
import {
  evaluateInsertion,
  INSERTION_STATES,
  insertionRecord,
  RESCOPE_ROLES,
  rescopeApproved,
  type InsertionRequest,
  type RescopeApproval,
} from './insertion.js';

/**
 * P2-INS-01 — hard insertion and the rescope approval.
 *
 * The negative properties are the ones under test: no agent can approve its own
 * insertion into live scope, and no approval can be given against an analysis
 * of something else.
 */

const graph: readonly WorkItemNode[] = [
  { id: 'EPIC-001', inFlight: false },
  { id: 'STORY-001', parentId: 'EPIC-001', inFlight: false },
];

const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, graph);

const request: InsertionRequest = {
  id: 'FEAT-042',
  kind: 'feature',
  title: 'expiring share links',
  into: 'EPIC-001',
  justification: 'blocks the pilot customer sign-off scheduled this sprint',
};

const pm: RescopeApproval = {
  actorId: 'dana',
  actorKind: 'human',
  roleId: 'pm',
  decision: 'approve',
};

describe('the states', () => {
  it('are proposed, approved, rejected', () => {
    expect([...INSERTION_STATES]).toEqual(['proposed', 'approved', 'rejected']);
  });
});

describe('rescopeApproved', () => {
  it('accepts a human in a rescope role', () => {
    expect(rescopeApproved([pm])).toBe(true);
    expect(rescopeApproved([{ ...pm, roleId: 'eng-lead' }])).toBe(true);
  });

  it('refuses an agent, whatever role it holds', () => {
    // The same device as the security-review gate: a role can be assigned to a
    // service account and `actorKind` cannot be argued with. An agent
    // proposing work and approving its own insertion into a live sprint is the
    // entire failure in one step.
    expect(rescopeApproved([{ ...pm, actorKind: 'agent' }])).toBe(false);
  });

  it('refuses a human without a rescope role', () => {
    expect(rescopeApproved([{ ...pm, roleId: 'developer' }])).toBe(false);
    expect(rescopeApproved([{ ...pm, roleId: undefined }])).toBe(false);
  });

  it('refuses a revoked approval', () => {
    expect(rescopeApproved([{ ...pm, revokedAt: '2026-08-14T00:00:00Z' }])).toBe(false);
  });

  it('keeps the role list narrow', () => {
    // Widening this to every role with write access turns the gate back into
    // the team norm it replaces.
    expect([...RESCOPE_ROLES]).toEqual(['pm', 'eng-lead']);
  });
});

describe('evaluateInsertion', () => {
  it('leaves an unapproved insertion at proposed', () => {
    const verdict = evaluateInsertion(request, radius, []);
    expect(verdict.state).toBe('proposed');
    expect(verdict.blockers.join(' ')).toContain('somebody already committed to');
  });

  it('approves once a human pm or eng-lead has signed off', () => {
    expect(evaluateInsertion(request, radius, [pm]).state).toBe('approved');
  });

  it('does not let an agent approval move it off proposed', () => {
    expect(evaluateInsertion(request, radius, [{ ...pm, actorKind: 'agent' }]).state).toBe(
      'proposed',
    );
  });

  it('refuses a blast radius computed for a different container', () => {
    // Not a formality: an approval given against someone else's analysis is an
    // approval for work nobody analysed, and nothing downstream would show it.
    const verdict = evaluateInsertion({ ...request, into: 'EPIC-002' }, radius, [pm]);
    expect(verdict.state).toBe('proposed');
    expect(verdict.blockers.join(' ')).toContain('does not describe this insertion');
  });

  it('holds a rejection against a later approval', () => {
    // If an approval could outvote a rejection, "keep asking" would be a valid
    // way through, and a gate with a retry loop is a delay rather than a gate.
    const verdict = evaluateInsertion(request, radius, [
      { actorId: 'sam', actorKind: 'human', roleId: 'eng-lead', decision: 'reject' },
      pm,
    ]);
    expect(verdict.state).toBe('rejected');
  });

  it('ignores a revoked rejection', () => {
    const verdict = evaluateInsertion(request, radius, [
      {
        actorId: 'sam',
        actorKind: 'human',
        roleId: 'eng-lead',
        decision: 'reject',
        revokedAt: '2026-08-14T00:00:00Z',
      },
      pm,
    ]);
    expect(verdict.state).toBe('approved');
  });

  it('blocks on a file-ownership conflict even with approval in hand', () => {
    const contended = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/auth/session.ts'] },
      [
        { id: 'EPIC-001', inFlight: false },
        {
          id: 'STORY-001',
          parentId: 'EPIC-001',
          inFlight: true,
          ownedPaths: ['src/auth/session.ts'],
        },
      ],
    );
    const verdict = evaluateInsertion(request, contended, [pm]);
    expect(verdict.state).toBe('proposed');
    expect(verdict.blockers.join(' ')).toContain('STORY-001');
  });
});

describe('evaluateInsertion — cautions inform, they do not block', () => {
  const deep: readonly WorkItemNode[] = [
    { id: 'EPIC-001', inFlight: false },
    { id: 'STORY-001', parentId: 'EPIC-001', inFlight: false },
    { id: 'TASK-001', parentId: 'STORY-001', inFlight: false },
    { id: 'TASK-002', parentId: 'TASK-001', inFlight: false },
  ];
  const truncated = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, deep);

  it('surfaces a truncated radius without refusing the insertion', () => {
    // Refusing every insertion into a well-connected epic makes the gate
    // something teams route around, and a routed-around gate protects nothing.
    const verdict = evaluateInsertion(request, truncated, [pm]);
    expect(verdict.state).toBe('approved');
    expect(verdict.cautions.join(' ')).toContain('lower bound');
  });

  it('names the unanalysed items rather than only counting them', () => {
    expect(evaluateInsertion(request, truncated, [pm]).cautions.join(' ')).toContain('TASK-002');
  });

  it('surfaces an in-flight overlap that shares no file', () => {
    const overlapping = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/billing/plan.ts'] },
      [
        { id: 'EPIC-001', inFlight: false },
        {
          id: 'STORY-001',
          parentId: 'EPIC-001',
          inFlight: true,
          ownedPaths: ['src/auth/session.ts'],
        },
      ],
    );
    const verdict = evaluateInsertion(request, overlapping, [pm]);
    expect(verdict.state).toBe('approved');
    expect(verdict.cautions.join(' ')).toContain('scope may no longer hold');
  });

  it('tells the approver when the insertion forces full regression', () => {
    const migrating = computeBlastRadius({ into: 'EPIC-001', workType: 'migrate' }, graph);
    expect(evaluateInsertion(request, migrating, [pm]).cautions.join(' ')).toContain(
      'full regression',
    );
  });

  it('notes a missing justification without blocking on it', () => {
    const verdict = evaluateInsertion({ ...request, justification: undefined }, radius, [pm]);
    expect(verdict.state).toBe('approved');
    expect(verdict.cautions.join(' ')).toContain('could not wait');
  });

  it('says nothing when there is nothing to note', () => {
    expect(evaluateInsertion(request, radius, [pm]).cautions).toEqual([]);
  });
});

describe('insertionRecord', () => {
  it('records an approved insertion', () => {
    const verdict = evaluateInsertion(request, radius, [pm]);
    const text = insertionRecord('INSERT-014', request, radius, verdict, '2026-08-14T09:00:00Z');
    expect(text).toContain('id: INSERT-014');
    expect(text).toContain('state: approved');
    expect(text).toContain('STORY-001');
  });

  it('records a rejected insertion just as fully', () => {
    // The design decision worth defending. Recording only what landed produces
    // an audit trail that answers "what got added" and cannot answer "what was
    // asked for and refused" — and the second is the question being asked when
    // a sprint is reconstructed a quarter later.
    const verdict = evaluateInsertion(request, radius, [
      { actorId: 'sam', actorKind: 'human', roleId: 'pm', decision: 'reject' },
    ]);
    const text = insertionRecord('INSERT-015', request, radius, verdict, '2026-08-14T09:00:00Z');
    expect(text).toContain('state: rejected');
    expect(text).toContain('rejected by sam');
    expect(text).toContain('blocks the pilot customer sign-off');
  });

  it('carries the truncation warning into the record', () => {
    const deepRadius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, [
      { id: 'EPIC-001', inFlight: false },
      { id: 'STORY-001', parentId: 'EPIC-001', inFlight: false },
      { id: 'TASK-001', parentId: 'STORY-001', inFlight: false },
      { id: 'TASK-002', parentId: 'TASK-001', inFlight: false },
    ]);
    const text = insertionRecord(
      'INSERT-016',
      request,
      deepRadius,
      evaluateInsertion(request, deepRadius, [pm]),
      '2026-08-14T09:00:00Z',
    );
    expect(text).toContain('lower bound');
  });

  it('records placement without implying anything was renumbered', () => {
    const verdict = evaluateInsertion(request, radius, [pm]);
    const text = insertionRecord(
      'INSERT-017',
      { ...request, after: 'STORY-001' },
      radius,
      verdict,
      '2026-08-14T09:00:00Z',
    );
    expect(text).toContain('after STORY-001');
  });

  it('says plainly when no justification was given', () => {
    const stripped = { ...request, justification: undefined };
    const text = insertionRecord(
      'INSERT-018',
      stripped,
      radius,
      evaluateInsertion(stripped, radius, [pm]),
      '2026-08-14T09:00:00Z',
    );
    expect(text).toContain('_Not recorded._');
  });
});

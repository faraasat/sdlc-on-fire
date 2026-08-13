import { describe, expect, it } from 'vitest';
import {
  computeBlastRadius,
  formatBlastRadius,
  MAX_HOPS,
  type WorkItemNode,
} from './blast-radius.js';

/**
 * P2-INS-01 — blast-radius analysis.
 *
 * The load-bearing property is not that the walk finds things. It is that when
 * the walk *stops*, it says so: `.research/11 §5` names a truncated radius
 * reading as a complete one as the failure mode to watch for, and a lower bound
 * presented as an answer is worse than no analysis at all.
 */

const node = (id: string, extra: Partial<WorkItemNode> = {}): WorkItemNode => ({
  id,
  inFlight: false,
  ...extra,
});

/** EPIC-001 ← STORY-001 ← TASK-001 ← TASK-002 : a chain three hops deep. */
const chain: readonly WorkItemNode[] = [
  node('EPIC-001'),
  node('STORY-001', { parentId: 'EPIC-001' }),
  node('TASK-001', { parentId: 'STORY-001' }),
  node('TASK-002', { parentId: 'TASK-001' }),
];

describe('the walk direction', () => {
  it('reaches the children of the container it is inserting into', () => {
    // `parent_id` points from child *up* to container, and an insertion targets
    // the container — so a forward-only walk from EPIC-001 reaches nothing,
    // which is precisely the set the insertion displaces.
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain);
    expect(radius.reached.map((r) => r.id)).toContain('STORY-001');
  });

  it('follows relates_to, blocks and blocked_by as well as parentage', () => {
    const graph = [
      node('EPIC-001'),
      node('FEAT-001', { relatesTo: ['EPIC-001'] }),
      node('FEAT-002', { blocks: ['EPIC-001'] }),
      node('FEAT-003', { blockedBy: ['EPIC-001'] }),
    ];
    const reached = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature' },
      graph,
    ).reached.map((r) => r.id);
    expect(reached).toEqual(expect.arrayContaining(['FEAT-001', 'FEAT-002', 'FEAT-003']));
  });

  it('does not report the insertion target as part of its own radius', () => {
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain);
    expect(radius.reached.map((r) => r.id)).not.toContain('EPIC-001');
  });

  it('records how far away each item is', () => {
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain);
    expect(radius.reached.find((r) => r.id === 'STORY-001')?.hop).toBe(1);
    expect(radius.reached.find((r) => r.id === 'TASK-001')?.hop).toBe(2);
  });
});

describe('the bound is reported, not hidden', () => {
  it('stops at the hop limit', () => {
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain);
    expect(MAX_HOPS).toBe(2);
    expect(radius.reached.map((r) => r.id)).not.toContain('TASK-002');
  });

  it('says the walk was truncated and names what it did not explore', () => {
    // The whole point. A radius that stopped and did not say so is
    // indistinguishable from one that found everything.
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain);
    expect(radius.truncated).toBe(true);
    expect(radius.unexplored).toEqual(['TASK-002']);
  });

  it('is not truncated when the graph genuinely ends inside the bound', () => {
    // Otherwise the warning fires on every insertion and stops being read.
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, [
      node('EPIC-001'),
      node('STORY-001', { parentId: 'EPIC-001' }),
    ]);
    expect(radius.truncated).toBe(false);
    expect(radius.unexplored).toEqual([]);
  });

  it('does not count an already-reached item as unexplored', () => {
    // A cycle back into the radius is not new territory, and reporting it as
    // unanalysed would manufacture a warning about work already in the list.
    const cyclic = [
      node('EPIC-001'),
      node('STORY-001', { parentId: 'EPIC-001' }),
      node('TASK-001', { parentId: 'STORY-001', relatesTo: ['EPIC-001'] }),
    ];
    const radius = computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, cyclic);
    expect(radius.truncated).toBe(false);
  });

  it('says so in the printed report', () => {
    const text = formatBlastRadius(
      computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain),
    );
    expect(text).toContain('lower bound');
    expect(text).toContain('TASK-002');
  });
});

describe('ownership findings', () => {
  const inFlightSharing = [
    node('EPIC-001'),
    node('STORY-001', {
      parentId: 'EPIC-001',
      inFlight: true,
      ownedPaths: ['src/auth/session.ts'],
    }),
  ];

  it('reports a shared file with in-flight work as a conflict', () => {
    const radius = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/auth/session.ts'] },
      inFlightSharing,
    );
    expect(radius.ownership).toHaveLength(1);
    expect(radius.ownership[0]?.severity).toBe('conflict');
    expect(radius.ownership[0]?.paths).toEqual(['src/auth/session.ts']);
  });

  it('reports in-flight work with no shared file as an overlap, not silence', () => {
    // `.research/11 §5`: the ownership check was built for concurrent-write
    // conflicts, and "does this overlap in-flight work" is a different
    // question. Overlap without a collision is still a planning risk — the
    // story someone is halfway through may be the one this insertion
    // invalidates.
    const radius = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/billing/plan.ts'] },
      inFlightSharing,
    );
    expect(radius.ownership.map((f) => f.severity)).toEqual(['overlap']);
  });

  it('says nothing about work that is not in flight', () => {
    const idle = [
      node('EPIC-001'),
      node('STORY-001', { parentId: 'EPIC-001', ownedPaths: ['src/auth/session.ts'] }),
    ];
    const radius = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/auth/session.ts'] },
      idle,
    );
    expect(radius.ownership).toEqual([]);
  });

  it('says nothing about in-flight work outside the radius', () => {
    const distant = [
      node('EPIC-001'),
      node('STORY-001', { parentId: 'EPIC-001' }),
      node('TASK-001', { parentId: 'STORY-001' }),
      node('TASK-002', {
        parentId: 'TASK-001',
        inFlight: true,
        ownedPaths: ['src/auth/session.ts'],
      }),
    ];
    const radius = computeBlastRadius(
      { into: 'EPIC-001', workType: 'feature', ownedPaths: ['src/auth/session.ts'] },
      distant,
    );
    // Not because it is safe — because it is past the bound, which the radius
    // reports separately rather than pretending to have checked.
    expect(radius.ownership).toEqual([]);
    expect(radius.unexplored).toContain('TASK-002');
  });
});

describe('regression scope', () => {
  it('defers to regressionScopeFor rather than re-deciding', () => {
    // One copy of "does this force full regression" (P2-LIFE-02). Two copies
    // is two chances to disagree.
    expect(
      computeBlastRadius({ into: 'EPIC-001', workType: 'migrate' }, chain).regression.scope,
    ).toBe('full');
    expect(
      computeBlastRadius({ into: 'EPIC-001', workType: 'feature' }, chain).regression.scope,
    ).toBe('selective');
  });

  it('escalates on a high-risk surface even for an ordinary work type', () => {
    const radius = computeBlastRadius(
      {
        into: 'EPIC-001',
        workType: 'feature',
        changed: [{ path: 'db/migrations/0007_add_column.sql' }],
      },
      chain,
    );
    expect(radius.regression.scope).toBe('full');
  });
});

describe('formatBlastRadius', () => {
  it('says plainly when nothing is within reach', () => {
    const text = formatBlastRadius(
      computeBlastRadius({ into: 'EPIC-999', workType: 'feature' }, chain),
    );
    expect(text).toContain('nothing within');
  });

  it('shows the regression decision and its reason', () => {
    const text = formatBlastRadius(
      computeBlastRadius({ into: 'EPIC-001', workType: 'migrate' }, chain),
    );
    expect(text).toContain('regression: full');
    expect(text).toContain('underneath code nobody edited');
  });
});

import { describe, expect, it } from 'vitest';
import { ROLE_REGISTRY } from '@sdlc-on-fire/core';
import { reconcile } from './reconcile.js';

/**
 * P1-AGENT-09 — reconciliation (ADR-0059).
 *
 * The line these tests defend: a specialist's claim is a proposal, not a
 * merge-authorizing fact. Reconciliation decides what is coherent enough to
 * hand to the gate, never whether the work is right.
 */

describe('reconcile', () => {
  it('merges disjoint work without complaint', () => {
    const result = reconcile([
      { role: 'sql', filesChanged: ['db/schema.sql'], summary: 'added a column' },
      { role: 'typescript', filesChanged: ['src/a.ts'], summary: 'used it' },
    ]);
    expect(result.coherent).toBe(true);
    expect(result.filesChanged).toEqual(['db/schema.sql', 'src/a.ts']);
  });

  it('reports two specialists editing one file rather than picking a winner', () => {
    const result = reconcile([
      { role: 'sql', filesChanged: ['src/a.ts'], summary: 'x' },
      { role: 'typescript', filesChanged: ['src/a.ts'], summary: 'y' },
    ]);
    // Breaking the tie by confidence would let the most assertive agent win —
    // peer-to-peer negotiation in a different hat.
    expect(result.coherent).toBe(false);
    expect(result.conflicts[0]?.kind).toBe('file-overlap');
    expect(result.conflicts[0]?.roles).toEqual(['sql', 'typescript']);
  });

  it('flags a specialist that wrote outside its declared scope', () => {
    const result = reconcile(
      [{ role: 'sql', filesChanged: ['src/app.tsx'], summary: 'tweaked the UI' }],
      ROLE_REGISTRY,
    );
    // The whole basis for trusting a scoped specialist is the scope.
    expect(result.conflicts.some((c) => c.kind === 'out-of-scope')).toBe(true);
  });

  it('accepts work inside the scope', () => {
    const result = reconcile(
      [{ role: 'sql', filesChanged: ['packages/db/src/schema.ts'], summary: 'a column' }],
      ROLE_REGISTRY,
    );
    expect(result.conflicts).toEqual([]);
  });

  it('carries an unresolved question up instead of merging over it', () => {
    const result = reconcile([
      {
        role: 'sql',
        filesChanged: ['db/schema.sql'],
        summary: 'added a column',
        openQuestions: ['is this migration reversible on a live table?'],
      },
    ]);
    // Merging over it is how a specialist's uncertainty disappears into a
    // summary and nobody sees it again.
    expect(result.coherent).toBe(false);
    expect(result.openQuestions).toHaveLength(1);
  });

  it('reports every conflict, not the first', () => {
    const result = reconcile([
      { role: 'sql', filesChanged: ['src/a.ts'], summary: 'x', openQuestions: ['q1'] },
      { role: 'typescript', filesChanged: ['src/a.ts'], summary: 'y' },
    ]);
    expect(result.conflicts).toHaveLength(2);
  });
});

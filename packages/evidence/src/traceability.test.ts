import { describe, expect, it } from 'vitest';
import { coverageFor, edgesFromClaims, edgesFromGateRun, recordEdges } from './traceability.js';

/**
 * P1-GATE-08 — the traceability graph (ADR-0032).
 *
 * The derivation tests matter most. A graph that records more than the run
 * proved makes coverage look complete on any evidence at all, which is worse
 * than having no graph: it answers the audit question wrongly and confidently.
 */

describe('edgesFromGateRun', () => {
  const base = { workItemId: 'FEAT-001', commitSha: 'a'.repeat(40), evidenceId: 7 };

  it('does not take the cross product of criteria and files', () => {
    const edges = edgesFromGateRun({
      ...base,
      acceptanceCriteria: ['AC-1', 'AC-2'],
      filesChanged: ['src/a.ts', 'src/b.ts'],
    });
    // 2 × 2 = 4 would assert that every criterion is satisfied by every file,
    // which is not a fact the run established. Each end is recorded separately
    // and joined through the shared evidence id — the only link actually proved.
    expect(edges).toHaveLength(4);
    expect(edges.filter((edge) => edge.acId !== undefined)).toHaveLength(2);
    expect(edges.filter((edge) => edge.filePath !== undefined)).toHaveLength(2);
    expect(edges.every((edge) => edge.evidenceId === 7)).toBe(true);
  });

  it('keeps a bare evidence edge when nothing else is known', () => {
    // The proof half of an edge whose requirement half nobody has linked yet.
    expect(edgesFromGateRun(base)).toHaveLength(1);
  });

  it('records nothing at all when there is no evidence and no ends', () => {
    expect(edgesFromGateRun({ workItemId: 'FEAT-001' })).toEqual([]);
  });

  it('carries the commit through every edge', () => {
    const edges = edgesFromGateRun({ ...base, testIds: ['t1', 't2'] });
    expect(edges.every((edge) => edge.commitSha === base.commitSha)).toBe(true);
    expect(edges.every((edge) => edge.origin === 'gate-evaluation')).toBe(true);
  });
});

describe('edgesFromClaims', () => {
  const results = [
    { claim: 'AC-1 holds', citedChunkId: 'docs/spec.md#2', verdict: 'supported' },
    { claim: 'AC-2 holds', citedChunkId: 'docs/spec.md#4', verdict: 'abstain' },
    { claim: 'AC-3 holds', citedChunkId: 'docs/gone.md#1', verdict: 'unsupported' },
  ];

  it('records only supported claims', () => {
    const edges = edgesFromClaims({ workItemId: 'FEAT-001', evidenceId: 9, results });
    // An abstained or unsupported claim is exactly the case where nothing was
    // established. Recording it would let coverage be raised by asserting
    // things nobody verified.
    expect(edges).toHaveLength(1);
    expect(edges[0]?.acId).toBe('AC-1 holds');
  });

  it('takes the file end from the chunk id', () => {
    const edges = edgesFromClaims({ workItemId: 'FEAT-001', results });
    expect(edges[0]?.filePath).toBe('docs/spec.md');
    expect(edges[0]?.origin).toBe('claim-verification');
  });
});

describe('recordEdges', () => {
  it('never throws when the write fails', async () => {
    const failing = {
      query: () => Promise.reject(new Error('table is gone')),
    };
    const result = await recordEdges(failing as never, [
      { workItemId: 'FEAT-001', acId: 'AC-1', origin: 'gate-evaluation' },
    ]);
    // The graph is an audit artifact. One that can block a passing build has
    // stopped being an artifact and become a dependency.
    expect(result).toEqual({ written: 0, failed: 1 });
  });

  it('reports how many landed rather than just succeeding', async () => {
    let calls = 0;
    const flaky = {
      query: () => {
        calls += 1;
        return calls === 2 ? Promise.reject(new Error('nope')) : Promise.resolve([]);
      },
    };
    const result = await recordEdges(flaky as never, [
      { workItemId: 'A', acId: 'AC-1', origin: 'manual' },
      { workItemId: 'A', acId: 'AC-2', origin: 'manual' },
      { workItemId: 'A', acId: 'AC-3', origin: 'manual' },
    ]);
    // A caller that cares can notice the shortfall instead of being told
    // nothing happened.
    expect(result).toEqual({ written: 2, failed: 1 });
  });
});

describe('coverageFor', () => {
  it('separates linked-to-code from linked-to-evidence', async () => {
    const db = {
      query: () =>
        Promise.resolve([
          { ac_id: 'AC-1', edges: '3', with_evidence: '2' },
          { ac_id: 'AC-2', edges: '1', with_evidence: '0' },
        ]),
    };
    const rows = await coverageFor(db as never, 'FEAT-001');
    expect(rows[0]).toEqual({ acId: 'AC-1', edges: 3, hasEvidence: true });
    // Linked to code nobody proved anything about — a different and more
    // interesting state than being unlinked.
    expect(rows[1]).toEqual({ acId: 'AC-2', edges: 1, hasEvidence: false });
  });
});

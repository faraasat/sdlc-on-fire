import { describe, expect, it } from 'vitest';
import {
  bindEvidence,
  summariseBinding,
  type EvidenceRow,
  type GateRow,
} from './evidence-binding.js';

/**
 * P3-KAN-03 — evidence bound to gates.
 *
 * The claim of this product is that a gate passed *for a reason you can
 * inspect*. A gate showing green with nothing behind it is indistinguishable
 * from a gate that was told to be green — the thing the product refuses from an
 * agent, made by the product about itself.
 */

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const gate = (over: Partial<GateRow> = {}): GateRow => ({
  id: 1,
  gate_name: 'tests',
  result: 'pass',
  ...over,
});

const evidence = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
  id: 10,
  kind: 'test',
  producer: 'daemon',
  git_sha: HEAD,
  confidence: 0.9,
  produced_at: '2026-08-22T10:00:00Z',
  ...over,
});

describe('bindEvidence', () => {
  it('binds evidence to the gate it satisfies', () => {
    const report = bindEvidence({
      gates: [gate()],
      evidence: [evidence()],
      links: [{ gate_id: 1, evidence_id: 10 }],
      headSha: HEAD,
    });
    expect(report.gates[0]?.evidence.map((row) => row.id)).toEqual([10]);
    expect(report.problemCount).toBe(0);
  });

  it('flags a passing gate with nothing behind it', () => {
    // The central case. A gate can only be trusted if you can see why.
    const report = bindEvidence({ gates: [gate()], evidence: [], links: [], headSha: HEAD });
    expect(report.gates[0]?.problems[0]?.problem).toBe('unsupported-gate');
  });

  it('does not flag a pending gate for having no evidence yet', () => {
    // Pending means the work has not happened. Only a *pass* with nothing
    // behind it is a claim that needs backing.
    const report = bindEvidence({
      gates: [gate({ result: 'pending' })],
      evidence: [],
      links: [],
      headSha: HEAD,
    });
    expect(report.gates[0]?.problems).toEqual([]);
  });

  it('flags evidence produced against a different commit', () => {
    // Staleness is the failure this exists for: the envelope is real, the
    // result was true, and it describes code that is no longer there.
    const report = bindEvidence({
      gates: [gate()],
      evidence: [evidence({ git_sha: OTHER })],
      links: [{ gate_id: 1, evidence_id: 10 }],
      headSha: HEAD,
    });
    expect(report.gates[0]?.problems[0]?.problem).toBe('stale-evidence');
    expect(report.gates[0]?.problems[0]?.because).toContain('no longer there');
  });

  it('flags expired evidence separately from stale evidence', () => {
    // Different causes and different fixes: one needs a re-run against HEAD,
    // the other needs a re-run because the result aged out.
    const report = bindEvidence({
      gates: [gate()],
      evidence: [evidence({ expires_at: '2026-01-01T00:00:00Z' })],
      links: [{ gate_id: 1, evidence_id: 10 }],
      headSha: HEAD,
      now: new Date('2026-08-22T00:00:00Z'),
    });
    expect(report.gates[0]?.problems.map((entry) => entry.problem)).toEqual(['expired-evidence']);
  });

  it('does not flag evidence that has not expired yet', () => {
    const report = bindEvidence({
      gates: [gate()],
      evidence: [evidence({ expires_at: '2027-01-01T00:00:00Z' })],
      links: [{ gate_id: 1, evidence_id: 10 }],
      headSha: HEAD,
      now: new Date('2026-08-22T00:00:00Z'),
    });
    expect(report.gates[0]?.problems).toEqual([]);
  });

  it('reports evidence bound to no gate at all', () => {
    // Produced, stored, and satisfying nothing. In a list it looks like
    // coverage; it is not.
    const report = bindEvidence({
      gates: [],
      evidence: [evidence()],
      links: [],
      headSha: HEAD,
    });
    expect(report.unbound.map((row) => row.id)).toEqual([10]);
    expect(report.problemCount).toBe(1);
  });

  it('counts one envelope bound to two gates as bound, not as orphaned', () => {
    const report = bindEvidence({
      gates: [gate({ id: 1 }), gate({ id: 2, gate_name: 'build' })],
      evidence: [evidence()],
      links: [
        { gate_id: 1, evidence_id: 10 },
        { gate_id: 2, evidence_id: 10 },
      ],
      headSha: HEAD,
    });
    expect(report.unbound).toEqual([]);
    expect(report.gates.every((entry) => entry.evidence.length === 1)).toBe(true);
  });

  it('ignores a link pointing at evidence that no longer exists', () => {
    // A dangling row should not crash a card view; it should simply bind
    // nothing, which the unsupported-gate check then reports.
    const report = bindEvidence({
      gates: [gate()],
      evidence: [],
      links: [{ gate_id: 1, evidence_id: 999 }],
      headSha: HEAD,
    });
    expect(report.gates[0]?.evidence).toEqual([]);
    expect(report.gates[0]?.problems[0]?.problem).toBe('unsupported-gate');
  });
});

describe('summariseBinding', () => {
  it('leads with the problem when there is one', () => {
    const report = bindEvidence({ gates: [gate()], evidence: [], links: [], headSha: HEAD });
    expect(summariseBinding(report.gates[0]!)).toContain('no evidence bound');
  });

  it('names the envelopes when there is no problem', () => {
    const report = bindEvidence({
      gates: [gate()],
      evidence: [evidence({ kind: 'test' })],
      links: [{ gate_id: 1, evidence_id: 10 }],
      headSha: HEAD,
    });
    expect(summariseBinding(report.gates[0]!)).toContain('test');
  });

  it('says "no evidence yet" for a gate that has not run', () => {
    const report = bindEvidence({
      gates: [gate({ result: 'pending' })],
      evidence: [],
      links: [],
      headSha: HEAD,
    });
    expect(summariseBinding(report.gates[0]!)).toBe('no evidence yet');
  });
});

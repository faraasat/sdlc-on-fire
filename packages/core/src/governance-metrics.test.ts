import { describe, expect, it } from 'vitest';
import {
  gatePassRates,
  humanInterventions,
  insertionFrequency,
  PR_DURATION_UNAVAILABLE,
  type ApprovalRow,
  type GateEvaluation,
  type InsertionRow,
} from './governance-metrics.js';

const gate = (over: Partial<GateEvaluation> = {}): GateEvaluation => ({
  workItemId: 'FEAT-001',
  gateName: 'evidence',
  result: 'pass',
  requiredRole: 'eng-lead',
  policyId: 1,
  ...over,
});

describe('gate pass rate (P6-INSTRUMENT-04, FEAT-MET-015)', () => {
  it('excludes pending gates from the denominator', () => {
    // A gate raised five minutes ago has not failed. Folding it in makes a
    // healthy policy look strict precisely when work is in flight.
    const [rate] = gatePassRates([gate(), gate({ result: 'fail' }), gate({ result: 'pending' })]);
    expect(rate?.passRate).toBeCloseTo(0.5);
    expect(rate?.pending).toBe(1);
    expect(rate?.evaluated).toBe(3);
  });

  it('reports no rate rather than 0% when nothing has been decided', () => {
    // A policy with no decisions and one that never passes both produce "0%"
    // from a naive implementation, and the first is an absence while the second
    // is an emergency.
    const [rate] = gatePassRates([gate({ result: 'pending' })]);
    expect(rate?.passRate).toBeNull();
  });

  it('keeps two policies apart even when they require the same role', () => {
    // Merging them hides which one is the strict one, which is the question the
    // metric exists to answer.
    const rates = gatePassRates([
      gate({ policyId: 1, result: 'pass' }),
      gate({ policyId: 2, result: 'fail' }),
    ]);
    expect(rates).toHaveLength(2);
    expect(rates.map((r) => r.key).sort()).toEqual(['1/eng-lead', '2/eng-lead']);
  });

  it('does not conflate no-policy with no-role', () => {
    const rates = gatePassRates([
      gate({ policyId: null, requiredRole: 'security' }),
      gate({ policyId: 3, requiredRole: null }),
    ]);
    expect(rates.map((r) => r.key).sort()).toEqual(['3/none', 'none/security']);
  });
});

describe('human interventions (FEAT-MET-004)', () => {
  const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
    actorKind: 'human',
    decision: 'approve',
    revokedAt: null,
    createdAt: '2026-08-24T00:00:00.000Z',
    ...over,
  });

  it('counts revocations separately from rejections', () => {
    // An approval later taken back is the number that says a gate is being
    // clicked through, and it is invisible if it is filed as a rejection.
    const report = humanInterventions([
      approval(),
      approval({ decision: 'request-changes' }),
      approval({ revokedAt: '2026-08-24T01:00:00.000Z' }),
    ]);
    expect(report.approvals).toBe(2);
    expect(report.rejections).toBe(1);
    expect(report.revocations).toBe(1);
  });

  it('surfaces an agent approval as a number, because it should be impossible', () => {
    // The schema refuses one outright (ADR-0010). A non-zero here is a broken
    // invariant showing up where it is cheapest to notice.
    expect(humanInterventions([approval({ actorKind: 'agent' })]).agentApprovals).toBe(1);
    expect(humanInterventions([approval()]).agentApprovals).toBe(0);
  });
});

describe('insertion frequency (FEAT-MET-014)', () => {
  const at = (day: number): string => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  const insertion = (over: Partial<InsertionRow> = {}): InsertionRow => ({
    id: 'INSERT-001',
    into: 'FEAT-001',
    state: 'approved',
    recordedAt: at(1),
    ...over,
  });

  it('reports no rate from a single record', () => {
    // "1 per 30 days" off one insertion is an extrapolation from a sample of one
    // wearing the clothes of a measurement.
    expect(insertionFrequency([insertion()]).perThirtyDays).toBeNull();
    expect(insertionFrequency([]).perThirtyDays).toBeNull();
  });

  it('rates insertions over the span they actually cover', () => {
    // Four insertions across 15 days is eight per 30 days, not four.
    const report = insertionFrequency([
      insertion({ id: 'a', recordedAt: at(1) }),
      insertion({ id: 'b', recordedAt: at(6) }),
      insertion({ id: 'c', recordedAt: at(11) }),
      insertion({ id: 'd', recordedAt: at(16) }),
    ]);
    expect(report.perThirtyDays).toBeCloseTo(8);
  });

  it('names the containers that absorbed the churn', () => {
    // A bare count says churn happened and not where.
    const report = insertionFrequency([
      insertion({ id: 'a', into: 'FEAT-009' }),
      insertion({ id: 'b', into: 'FEAT-009' }),
      insertion({ id: 'c', into: 'FEAT-001' }),
    ]);
    expect(report.byContainer[0]).toEqual({ into: 'FEAT-009', insertions: 2 });
  });

  it('counts a held insertion as neither approved nor rejected', () => {
    // `proposed` is a real outcome — the record exists precisely so a held
    // request is not invisible.
    const report = insertionFrequency([insertion({ state: 'proposed' })]);
    expect(report.proposed).toBe(1);
    expect(report.approved).toBe(0);
    expect(report.rejected).toBe(0);
  });
});

describe('PR duration (FEAT-MET-009)', () => {
  it('is a typed absence that says what it would take', () => {
    // A governance section that silently lacks PR duration reads as "PRs are not
    // slow". The whole discipline here is that an unmeasured thing says so.
    expect(PR_DURATION_UNAVAILABLE.available).toBe(false);
    expect(PR_DURATION_UNAVAILABLE.because).toContain('merged');
  });
});

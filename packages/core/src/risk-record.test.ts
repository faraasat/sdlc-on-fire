import { describe, expect, it } from 'vitest';
import { RISK_SURFACES } from './risk-surface.js';
import { RISK_SEVERITY, RiskRecordSchema, riskRecordId, riskRecordsFor } from './risk-record.js';

const at = '2026-08-23T00:00:00.000Z';

describe('risk severity (P6-WRITEPATH-02)', () => {
  it('grades every surface in the vocabulary', () => {
    // Total, or a new surface produces a record with no severity and the
    // artifact silently loses the field it exists to carry.
    for (const surface of RISK_SURFACES) {
      expect(RISK_SEVERITY[surface]?.severity, surface).toBeDefined();
      expect(RISK_SEVERITY[surface]?.because.length, surface).toBeGreaterThan(0);
    }
    expect(Object.keys(RISK_SEVERITY).sort()).toEqual([...RISK_SURFACES].sort());
  });

  it('has no low grade at all', () => {
    // A surface that could be low is a surface that should not have been in
    // RISK_SURFACES. Offering `low` here would let the grading undo the
    // detection, one surface at a time.
    const grades = new Set(Object.values(RISK_SEVERITY).map((g) => g.severity));
    expect(grades.has('high')).toBe(true);
    expect([...grades].sort()).toEqual(['high', 'medium']);
  });
});

describe('risk records (P6-WRITEPATH-02)', () => {
  it('writes one record per surface, not one per file', () => {
    // "This change touches payments" is the reviewable unit. Nine records for
    // nine payment files is a backlog nobody reads.
    const records = riskRecordsFor(
      [
        { surface: 'payments', path: 'src/charge.ts', evidence: 'path is payments code' },
        { surface: 'payments', path: 'src/refund.ts', evidence: 'path is payments code' },
        { surface: 'auth', path: 'src/auth.ts', evidence: 'path is authentication code' },
      ],
      'FEAT-001',
      1,
      at,
    );
    expect(records.map((r) => r.surface)).toEqual(['payments', 'auth']);
    expect(records[0]?.evidence).toHaveLength(2);
    expect(records.map((r) => r.id)).toEqual(['RISK-001', 'RISK-002']);
  });

  it('opens every generated record with no mitigation', () => {
    // The record states the surface and the evidence and stops. An auto-written
    // mitigation is a conclusion nobody reached, sitting where the person whose
    // job it is to reach one will read it as though somebody did.
    const [record] = riskRecordsFor(
      [{ surface: 'secrets', path: '.env.example', evidence: 'reads a secret' }],
      'FEAT-001',
      4,
      at,
    );
    expect(record?.status).toBe('open');
    expect(record?.mitigation).toBeNull();
    expect(record?.accepted_because).toBeNull();
    expect(record?.severity).toBe('high');
  });

  it('refuses a status that outruns its justification', () => {
    const base = {
      id: 'RISK-001',
      work_item_id: 'FEAT-001',
      surface: 'auth',
      severity: 'high',
      evidence: [{ path: 'src/auth.ts', matched: 'path is authentication code' }],
      mitigation: null,
      accepted_because: null,
      created_at: at,
    };
    // "Mitigated" with nothing written down is a risk that was closed rather
    // than handled, and it reads identically to one that was handled.
    expect(RiskRecordSchema.safeParse({ ...base, status: 'mitigated' }).success).toBe(false);
    expect(RiskRecordSchema.safeParse({ ...base, status: 'accepted' }).success).toBe(false);
    expect(RiskRecordSchema.safeParse({ ...base, status: 'open' }).success).toBe(true);
    expect(
      RiskRecordSchema.safeParse({ ...base, status: 'mitigated', mitigation: 'moved to the vault' })
        .success,
    ).toBe(true);
  });

  it('refuses a record with no evidence', () => {
    // A risk with no evidence is a worry. The evidence is what makes it
    // possible to disagree with.
    expect(
      RiskRecordSchema.safeParse({
        id: 'RISK-001',
        work_item_id: 'FEAT-001',
        surface: 'auth',
        severity: 'high',
        evidence: [],
        status: 'open',
        mitigation: null,
        accepted_because: null,
        created_at: at,
      }).success,
    ).toBe(false);
  });

  it('zero-pads ids', () => {
    expect(riskRecordId(7)).toBe('RISK-007');
    expect(riskRecordId(142)).toBe('RISK-142');
  });
});

import { describe, expect, it } from 'vitest';
import { RISK_SURFACES } from './risk-surface.js';
import {
  RISK_SEVERITY,
  RiskRecordSchema,
  blastRadiusRisks,
  riskRecordId,
  riskRecordsFor,
} from './risk-record.js';

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

describe('blast-radius risk records (P6-WRITEPATH-02, FEAT-SEC-005)', () => {
  const at = '2026-08-24T00:00:00.000Z';

  it('files one record per colliding item, not per file', () => {
    // Three files shared with the same story is one conversation. Three cards
    // would make it look like three problems.
    const records = blastRadiusRisks(
      [
        { path: 'src/a.ts', withItem: 'FEAT-009' },
        { path: 'src/b.ts', withItem: 'FEAT-009' },
        { path: 'src/c.ts', withItem: 'FEAT-002' },
      ],
      'FEAT-001',
      1,
      at,
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.evidence).toHaveLength(2);
  });

  it('carries no surface, because entanglement is not one', () => {
    const [record] = blastRadiusRisks(
      [{ path: 'src/a.ts', withItem: 'FEAT-009' }],
      'FEAT-001',
      1,
      at,
    );
    expect(record?.source).toBe('blast-radius');
    expect(record?.surface).toBeNull();
  });

  it('grades a collision medium, on the reversibility axis', () => {
    // `high` is reserved for damage that does not come back. Two agents writing
    // one file produces a merge somebody has to do: expensive, and recoverable.
    const [record] = blastRadiusRisks(
      [{ path: 'src/a.ts', withItem: 'FEAT-009' }],
      'FEAT-001',
      1,
      at,
    );
    expect(record?.severity).toBe('medium');
  });

  it('files nothing when nothing collides', () => {
    expect(blastRadiusRisks([], 'FEAT-001', 1, at)).toEqual([]);
  });

  it('names the item collided with, in the evidence', () => {
    // The evidence is what makes the record actionable — and it is what the
    // dedupe reads back, so a record that did not name it would be filed again
    // on every scan.
    const [record] = blastRadiusRisks(
      [{ path: 'src/a.ts', withItem: 'FEAT-009' }],
      'FEAT-001',
      1,
      at,
    );
    expect(record?.evidence[0]?.matched).toContain('FEAT-009');
  });
});

describe("the two sources cannot hold each other's shape", () => {
  const base = {
    id: 'RISK-001',
    work_item_id: 'FEAT-001',
    severity: 'high' as const,
    evidence: [{ path: 'src/auth.ts', matched: 'path is auth' }],
    status: 'open' as const,
    mitigation: null,
    accepted_because: null,
    created_at: '2026-08-24T00:00:00.000Z',
  };

  it('refuses a risk-surface record with no surface', () => {
    // Letting either hold the other's shape makes `surface` mean "sometimes
    // present", which is how a consumer ends up printing `?? 'unknown'`.
    expect(
      RiskRecordSchema.safeParse({ ...base, source: 'risk-surface', surface: null }).success,
    ).toBe(false);
  });

  it('refuses a blast-radius record that claims a surface', () => {
    expect(
      RiskRecordSchema.safeParse({ ...base, source: 'blast-radius', surface: 'auth' }).success,
    ).toBe(false);
  });

  it('reads a record written before `source` existed', () => {
    // The records live in git. A required field added to an artifact on disk
    // makes every existing one invalid, and "run this migration over your
    // repository" is not a thing to ask of a workspace whose whole promise is
    // that the files are the truth.
    const parsed = RiskRecordSchema.safeParse({ ...base, surface: 'auth' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.source).toBe('risk-surface');
  });
});

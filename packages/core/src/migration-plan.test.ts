import { describe, expect, it } from 'vitest';
import {
  BACKFILL_BOUNDS,
  formatPlanVerdict,
  MIGRATION_PHASES,
  phasesAreSeparate,
  validateMigrationPlan,
  type MigrationPlan,
} from './migration-plan.js';

/**
 * P2-SKILL-06 — the database-migration checklist.
 *
 * The pattern is decades old and needs no defending. What is under test is the
 * checker, and specifically the asymmetry it exists for: expand and backfill
 * are reversible, contract is not, and the two are therefore held to different
 * standards.
 */

const expand: MigrationPlan = {
  phase: 'expand',
  summary: 'add users.email_verified_at alongside the boolean',
  rollback: 'drop the new column; nothing reads it yet',
};

const backfill: MigrationPlan = {
  phase: 'backfill',
  summary: 'copy users.email_verified into email_verified_at',
  rollback: 'stop the job; the new column is not read yet',
  batchSize: 5_000,
  pauseMs: 100,
  measuredAgainstRows: 41_000_000,
};

const contract: MigrationPlan = {
  phase: 'contract',
  summary: 'drop users.email_verified',
  unreferencedEvidence: 'zero reads in pg_stat_statements over 14 days; grep of all services clean',
  expandedIn: 'MIGRATE-041',
};

describe('the phases', () => {
  it('are the three of expand-contract', () => {
    expect([...MIGRATION_PHASES]).toEqual(['expand', 'backfill', 'contract']);
  });
});

describe('validateMigrationPlan — reversible phases', () => {
  it('accepts a complete expand', () => {
    expect(validateMigrationPlan(expand).ready).toBe(true);
  });

  it('accepts a complete backfill', () => {
    expect(validateMigrationPlan(backfill).ready).toBe(true);
  });

  it('blocks an expand with no rollback', () => {
    // Reversibility is the only reason it is safe to run first.
    const verdict = validateMigrationPlan({ ...expand, rollback: undefined });
    expect(verdict.ready).toBe(false);
    expect(verdict.findings[0]?.message).toContain('reversible');
  });

  it('does not accept a token rollback', () => {
    expect(validateMigrationPlan({ ...expand, rollback: 'revert' }).ready).toBe(false);
  });

  it('blocks a plan nobody described', () => {
    expect(validateMigrationPlan({ ...expand, summary: 'fix db' }).ready).toBe(false);
  });
});

describe('validateMigrationPlan — the irreversible phase', () => {
  it('accepts a contract with evidence and a prior expand', () => {
    expect(validateMigrationPlan(contract).ready).toBe(true);
  });

  it('blocks a contract with no evidence the old structure is unused', () => {
    const verdict = validateMigrationPlan({ ...contract, unreferencedEvidence: undefined });
    expect(verdict.ready).toBe(false);
    // "We think nothing uses it" is not a finding.
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('not a finding');
  });

  it('blocks a contract with no expand behind it', () => {
    const verdict = validateMigrationPlan({ ...contract, expandedIn: undefined });
    expect(verdict.ready).toBe(false);
    // A destructive change wearing the pattern's name.
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('destructive change');
  });

  it('does not ask a contract for a rollback', () => {
    // Asking invites an answer, and any answer would be false — the data is
    // gone. Naming that is more useful than a field somebody fills with
    // "restore from backup".
    const verdict = validateMigrationPlan({ ...contract, rollback: undefined });
    expect(verdict.ready).toBe(true);
  });

  it('flags a contract that claims one anyway', () => {
    const verdict = validateMigrationPlan({ ...contract, rollback: 'restore from the backup' });
    expect(verdict.ready).toBe(true);
    expect(verdict.findings.some((f) => f.severity === 'review')).toBe(true);
  });
});

describe('validateMigrationPlan — batching', () => {
  it('blocks a backfill with no batch size', () => {
    const verdict = validateMigrationPlan({ ...backfill, batchSize: undefined });
    expect(verdict.ready).toBe(false);
    expect(verdict.findings[0]?.message).toContain('locks the table');
  });

  it('flags a batch above the upper bound', () => {
    const verdict = validateMigrationPlan({ ...backfill, batchSize: 500_000 });
    // Review, not blocking: whether it is too large depends on the table, and
    // only a person knows the table.
    expect(verdict.ready).toBe(true);
    expect(verdict.findings.some((f) => f.message.includes('replication lag'))).toBe(true);
  });

  it('flags a batch below the lower bound too', () => {
    // The lower bound matters as much: a backfill still running the next
    // morning is one somebody kills halfway, leaving the half-migrated state
    // permanently rather than temporarily.
    const verdict = validateMigrationPlan({ ...backfill, batchSize: 50 });
    expect(verdict.findings.some((f) => f.message.includes('kills halfway'))).toBe(true);
  });

  it('flags a backfill with no pause', () => {
    const verdict = validateMigrationPlan({ ...backfill, pauseMs: 0 });
    expect(verdict.findings.some((f) => f.message.includes('starves the application'))).toBe(true);
  });

  it('blocks a backfill timed against nothing', () => {
    // `.research/32`: dev-DB timing is not representative. The number nobody
    // wrote down is the number nobody measured.
    const verdict = validateMigrationPlan({ ...backfill, measuredAgainstRows: undefined });
    expect(verdict.ready).toBe(false);
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('not representative');
  });

  it('does not demand batching of the other phases', () => {
    expect(validateMigrationPlan(expand).ready).toBe(true);
    expect(validateMigrationPlan(contract).ready).toBe(true);
  });

  it('keeps its bounds nameable rather than inlined', () => {
    expect(BACKFILL_BOUNDS.minBatch).toBe(1_000);
    expect(BACKFILL_BOUNDS.maxBatch).toBe(10_000);
  });
});

describe('phasesAreSeparate', () => {
  it('blocks expand and contract landing together', () => {
    // The failure that motivates the whole pattern: no deploy in which both the
    // old and new structure work. The intermediate state is the mechanism, not
    // the overhead.
    const findings = phasesAreSeparate([expand, contract]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('no deploy in which both');
  });

  it('allows expand and backfill together', () => {
    // Both reversible, and shipping them together is ordinary.
    expect(phasesAreSeparate([expand, backfill])).toEqual([]);
  });

  it('allows a contract on its own', () => {
    expect(phasesAreSeparate([contract])).toEqual([]);
  });
});

describe('formatPlanVerdict', () => {
  it('says plainly that contract is the point of no return', () => {
    expect(formatPlanVerdict(validateMigrationPlan(contract))).toContain('the old data is gone');
  });

  it('does not say that about a reversible phase', () => {
    expect(formatPlanVerdict(validateMigrationPlan(expand))).not.toContain('old data is gone');
  });

  it('lists every finding with its severity', () => {
    const text = formatPlanVerdict(
      validateMigrationPlan({ ...backfill, batchSize: undefined, pauseMs: 0 }),
    );
    expect(text).toContain('[blocking]');
    expect(text).toContain('[review]');
  });
});

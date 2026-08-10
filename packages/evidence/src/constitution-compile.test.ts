import { ConstitutionSchema, type Constitution } from '@sdlc-on-fire/core';
import { describe, expect, it } from 'vitest';
import { compileConstitution, demandedKinds, formatSyncImpact } from './constitution-compile.js';

function constitution(principles: unknown[]): Constitution {
  return ConstitutionSchema.parse({
    $schema: 'https://sdlc-on-fire.dev/schema/constitution.json',
    title: 'Project Constitution',
    version: '1.0.0',
    principles,
  });
}

describe('compilation', () => {
  it('compiles an enforced principle into a policy', () => {
    const result = compileConstitution(
      constitution([
        {
          id: 'P1',
          statement: 'All tests must pass.',
          evidence_enforced: true,
          gate_ref: 'standard',
        },
      ]),
    );
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]?.name).toBe('standard');
    expect(result.policies[0]?.evidence.map((e) => e.kind)).toEqual(['test']);
    expect(result.impact.compiled).toEqual(['P1']);
  });

  it('compiles multiple demands from one principle', () => {
    const result = compileConstitution(
      constitution([
        {
          id: 'P1',
          statement: 'tests and typecheck must pass',
          evidence_enforced: true,
          gate_ref: 'g',
        },
      ]),
    );
    expect(result.policies[0]?.evidence.map((e) => e.kind).sort()).toEqual(['test', 'typecheck']);
  });

  it('leaves an unenforced principle advisory and says so', () => {
    // A constitution is not a README: the distinction has to be visible.
    const result = compileConstitution(
      constitution([{ id: 'P2', statement: 'Prefer clarity.', evidence_enforced: false }]),
    );
    expect(result.policies).toHaveLength(0);
    expect(result.impact.advisory).toEqual(['P2']);
  });

  it('reports an enforced principle naming nothing checkable', () => {
    // Compiling it to an empty policy would make it pass trivially — worse than
    // reporting it as unsatisfiable.
    const result = compileConstitution(
      constitution([
        { id: 'P3', statement: 'Code should be elegant.', evidence_enforced: true, gate_ref: 'g' },
      ]),
    );
    expect(result.policies).toHaveLength(0);
    expect(result.impact.unsatisfiable[0]?.principleId).toBe('P3');
  });

  it('falls back to the principle id when no gate_ref is set', () => {
    const result = compileConstitution(
      constitution([
        { id: 'P4', statement: 'tests must pass', evidence_enforced: true, gate_ref: 'P4' },
      ]),
    );
    expect(result.policies[0]?.name).toBe('P4');
  });

  it('is deterministic', () => {
    const c = constitution([
      { id: 'P1', statement: 'tests must pass', evidence_enforced: true, gate_ref: 'g' },
    ]);
    expect(JSON.stringify(compileConstitution(c))).toBe(JSON.stringify(compileConstitution(c)));
  });
});

describe('demanded kinds', () => {
  it('recognises the closed vocabulary', () => {
    expect(demandedKinds({ id: 'x', statement: 'run the build', evidence_enforced: true })).toEqual(
      ['build'],
    );
  });

  it('returns nothing for prose with no demand', () => {
    expect(demandedKinds({ id: 'x', statement: 'be kind', evidence_enforced: true })).toEqual([]);
  });
});

describe('sync-impact report', () => {
  it('names unsatisfiable principles prominently', () => {
    const result = compileConstitution(
      constitution([{ id: 'P3', statement: 'be elegant', evidence_enforced: true, gate_ref: 'g' }]),
    );
    expect(formatSyncImpact(result.impact)).toContain('UNSATISFIABLE P3');
  });

  it('reports empty sections explicitly rather than omitting them', () => {
    const report = formatSyncImpact({ compiled: [], advisory: [], unsatisfiable: [] });
    expect(report).toContain('(none)');
  });
});

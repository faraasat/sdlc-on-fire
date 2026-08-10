import { describe, expect, it } from 'vitest';
import {
  ChangeSchema,
  DecisionSchema,
  DOC_SCHEMAS,
  hasDocSchema,
  orderDeltas,
  ResearchSchema,
  SpecDeltaSchema,
  SpecSchema,
  type SpecDelta,
} from './docs.js';

const URL_ = 'https://sdlc-on-fire.dev/schema/x.json';

describe('spec', () => {
  const base = {
    $schema: URL_,
    title: 'CSV export',
    slug: 'csv-export',
    status: 'draft',
    requirements: ['The system MUST reject a malformed payload.'],
    non_goals: ['Streaming very large files is out of scope for this spec.'],
  };

  it('accepts a well-formed spec', () => {
    expect(SpecSchema.safeParse(base).success).toBe(true);
  });

  it('requires non-goals, and requires them to say something (P1-OBJ-06)', () => {
    // Scope creep is rarely a decision anyone makes; it is the absence of one,
    // and an empty non-goals list is what that absence looks like on disk.
    const { non_goals: _dropped, ...without } = base;
    expect(SpecSchema.safeParse(without).success).toBe(false);
    expect(SpecSchema.safeParse({ ...base, non_goals: [] }).success).toBe(false);
    expect(SpecSchema.safeParse({ ...base, non_goals: [''] }).success).toBe(false);
  });

  it('defaults ac_style to bdd, the style the shipped spec skill emits (P1-OBJ-05)', () => {
    const parsed = SpecSchema.parse(base);
    expect(parsed.ac_style).toBe('bdd');
  });

  it('accepts the three declared ac styles and nothing else', () => {
    for (const style of ['bdd', 'tdd', 'contract-first']) {
      expect(SpecSchema.safeParse({ ...base, ac_style: style }).success, style).toBe(true);
    }
    // An unrecognised style would be silently carried into a skill that renders
    // per style, which is how a spec gets restyled by whoever picks it up.
    expect(SpecSchema.safeParse({ ...base, ac_style: 'gherkin' }).success).toBe(false);
  });

  it('requires a kebab-case slug', () => {
    expect(SpecSchema.safeParse({ ...base, slug: 'CSV Export' }).success).toBe(false);
  });

  it('requires at least one requirement', () => {
    expect(SpecSchema.safeParse({ ...base, requirements: [] }).success).toBe(false);
  });
});

describe('change deltas', () => {
  const base = {
    $schema: URL_,
    change_id: 'add-csv-export',
    spec_ref: 'docs/specs/csv-export/spec.md',
    status: 'proposed',
    proposed_by: 'dev',
    deltas: [{ kind: 'ADDED', requirement_id: 'R1', text: 'MUST export CSV.' }],
  };

  it('accepts a well-formed change', () => {
    expect(ChangeSchema.safeParse(base).success).toBe(true);
  });

  it('rejects two deltas of the same kind on one requirement', () => {
    // The outcome would depend on ordering the application order does not define.
    const result = ChangeSchema.safeParse({
      ...base,
      deltas: [
        { kind: 'MODIFIED', requirement_id: 'R1', text: 'a' },
        { kind: 'MODIFIED', requirement_id: 'R1', text: 'b' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('orders deltas RENAMED → REMOVED → MODIFIED → ADDED', () => {
    // Applying in any other order produces a different spec from the same change.
    const deltas: SpecDelta[] = [
      { kind: 'ADDED', requirement_id: 'R4', text: 'd' },
      { kind: 'MODIFIED', requirement_id: 'R3', text: 'c' },
      { kind: 'REMOVED', requirement_id: 'R2', text: 'b' },
      { kind: 'RENAMED', requirement_id: 'R1', text: 'a' },
    ];
    expect(orderDeltas(deltas).map((d) => d.kind)).toEqual([
      'RENAMED',
      'REMOVED',
      'MODIFIED',
      'ADDED',
    ]);
  });

  it('is stable within a kind', () => {
    const deltas: SpecDelta[] = [
      { kind: 'ADDED', requirement_id: 'R1', text: 'first' },
      { kind: 'ADDED', requirement_id: 'R2', text: 'second' },
    ];
    expect(orderDeltas(deltas).map((d) => d.requirement_id)).toEqual(['R1', 'R2']);
  });
});

describe('decision', () => {
  const base = {
    $schema: URL_,
    adr_id: 'ADR-0001-hybrid-execution-model',
    title: 'Hybrid execution model',
    status: 'accepted',
  };

  it('accepts a well-formed ADR', () => {
    expect(DecisionSchema.safeParse(base).success).toBe(true);
  });

  it('requires a well-formed ADR id', () => {
    expect(DecisionSchema.safeParse({ ...base, adr_id: 'ADR-1' }).success).toBe(false);
  });

  it('rejects an ADR superseding itself', () => {
    expect(DecisionSchema.safeParse({ ...base, supersedes: base.adr_id }).success).toBe(false);
  });

  it('requires superseded_by when the status says superseded', () => {
    // Otherwise a reader hits a dead end.
    expect(DecisionSchema.safeParse({ ...base, status: 'superseded' }).success).toBe(false);
    expect(
      DecisionSchema.safeParse({
        ...base,
        status: 'superseded',
        superseded_by: 'ADR-0002-postgres-pgvector-day-one',
      }).success,
    ).toBe(true);
  });
});

describe('research', () => {
  const base = { $schema: URL_, title: 'PGlite limits', topic: 'storage' };

  it('accepts a note with no sources', () => {
    expect(ResearchSchema.safeParse(base).success).toBe(true);
  });

  it('requires sources to be real URLs', () => {
    // An invented citation is worse than none (CLAUDE.md guardrail).
    expect(ResearchSchema.safeParse({ ...base, sources: ['see the docs'] }).success).toBe(false);
    expect(ResearchSchema.safeParse({ ...base, sources: ['https://pglite.dev'] }).success).toBe(
      true,
    );
  });

  it('requires related work items to be real IDs', () => {
    expect(ResearchSchema.safeParse({ ...base, related_work_items: ['whatever'] }).success).toBe(
      false,
    );
  });
});

describe('registry', () => {
  it('exposes all four doc schemas', () => {
    expect(Object.keys(DOC_SCHEMAS).sort()).toEqual(['change', 'decision', 'research', 'spec']);
  });

  it('reports which doc types have a schema', () => {
    expect(hasDocSchema('spec')).toBe(true);
    expect(hasDocSchema('risk')).toBe(false);
  });
});

describe('ac_style on a delta (P1-OBJ-05)', () => {
  const delta = { kind: 'MODIFIED', requirement_id: 'R-1', text: 'The system MUST retry once.' };

  it('is optional, so a delta inherits the spec style', () => {
    // Restating it per delta would invite drift between the delta and the spec
    // it amends.
    expect(SpecDeltaSchema.safeParse(delta).success).toBe(true);
    expect(SpecDeltaSchema.parse(delta).ac_style).toBeUndefined();
  });

  it('can override, for a criterion written in a different style', () => {
    expect(SpecDeltaSchema.parse({ ...delta, ac_style: 'tdd' }).ac_style).toBe('tdd');
  });

  it('rejects an unknown style rather than passing it through', () => {
    expect(SpecDeltaSchema.safeParse({ ...delta, ac_style: 'nonsense' }).success).toBe(false);
  });
});

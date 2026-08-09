import { describe, expect, it } from 'vitest';
import { ConstitutionSchema } from './constitution.js';
import { ContextPackSchema, ContextPackSpecSchema, isWithinBudget } from './context.js';
import { MemorySchema, MEMORY_SUMMARY_MAX_CHARS } from './memory.js';
import { isTerminalRunStatus, RunSchema } from './run.js';

const SCHEMA_URL = 'https://sdlc-on-fire.dev/schema/x.json';

describe('constitution', () => {
  const base = {
    $schema: SCHEMA_URL,
    title: 'Project Constitution',
    version: '1.0.0',
    principles: [
      { id: 'P1', statement: 'Tests must pass', evidence_enforced: true, gate_ref: 'standard' },
      { id: 'P2', statement: 'Prefer clarity', evidence_enforced: false },
    ],
  };

  it('accepts a well-formed constitution', () => {
    expect(ConstitutionSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an enforced principle with nothing enforcing it', () => {
    const result = ConstitutionSchema.safeParse({
      ...base,
      principles: [{ id: 'P1', statement: 'Tests must pass', evidence_enforced: true }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('gate_ref'))).toBe(true);
    }
  });

  it('rejects duplicate principle ids', () => {
    const result = ConstitutionSchema.safeParse({
      ...base,
      principles: [
        { id: 'P1', statement: 'One', evidence_enforced: false },
        { id: 'P1', statement: 'Two', evidence_enforced: false },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('requires semver', () => {
    expect(ConstitutionSchema.safeParse({ ...base, version: 'v1' }).success).toBe(false);
    expect(ConstitutionSchema.safeParse({ ...base, version: '1.0.0-rc.1' }).success).toBe(true);
  });
});

describe('run', () => {
  const base = {
    id: 'run_01',
    work_item_id: 'TASK-001',
    status: 'running',
    started_at: '2026-08-10T00:00:00.000Z',
  };

  it('accepts an in-flight run with no finish time', () => {
    expect(RunSchema.safeParse(base).success).toBe(true);
  });

  it('requires finished_at once the status is terminal', () => {
    for (const status of ['pass', 'fail', 'error'] as const) {
      expect(isTerminalRunStatus(status)).toBe(true);
      expect(RunSchema.safeParse({ ...base, status }).success).toBe(false);
      expect(
        RunSchema.safeParse({ ...base, status, finished_at: '2026-08-10T00:01:00.000Z' }).success,
      ).toBe(true);
    }
  });

  it('rejects a finish that precedes the start', () => {
    const result = RunSchema.safeParse({
      ...base,
      status: 'pass',
      finished_at: '2026-08-09T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a finish with no start', () => {
    const { started_at: _startedAt, ...noStart } = base;
    expect(
      RunSchema.safeParse({
        ...noStart,
        status: 'pass',
        finished_at: '2026-08-10T00:01:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('rejects a work_item_id that is not a work-item ID', () => {
    expect(RunSchema.safeParse({ ...base, work_item_id: 'whatever' }).success).toBe(false);
  });
});

describe('context pack', () => {
  const spec = {
    skillId: 'implement',
    stageId: 'implement',
    budget: { max: 100 },
    sources: { include: [{ kind: 'work_item', id: 'TASK-001' }] },
    freshness: { revalidateOnAssembly: true },
    isolation: 'fresh-subagent',
    disposer: 'assembleContextPack.truncateToBudget',
  };

  const pack = {
    packId: '3f1b7c22-9a4e-4a3e-8f2b-2c4a1d5e6f70',
    skillId: 'implement',
    stageId: 'implement',
    cardId: 'TASK-001',
    effortTier: 'max',
    layers: [
      { kind: 'skill-stable', content: 'stable', tokens: 40 },
      { kind: 'card-core', content: 'card', tokens: 20 },
    ],
    stableUpToIndex: 0,
    totalTokens: 60,
    assembledAt: '2026-08-10T00:00:00.000Z',
  };

  it('accepts a well-formed spec and pack', () => {
    expect(ContextPackSpecSchema.safeParse(spec).success).toBe(true);
    expect(ContextPackSchema.safeParse(pack).success).toBe(true);
  });

  it('pins the disposer literal so the guarantee cannot be renamed away', () => {
    expect(
      ContextPackSpecSchema.safeParse({ ...spec, disposer: 'the-model-decides' }).success,
    ).toBe(false);
  });

  it('rejects a totalTokens that disagrees with its layers', () => {
    // Otherwise budget enforcement measures a number nothing produced.
    const result = ContextPackSchema.safeParse({ ...pack, totalTokens: 999 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('totalTokens'))).toBe(true);
    }
  });

  it('rejects a cache boundary past the end of the layer list', () => {
    expect(ContextPackSchema.safeParse({ ...pack, stableUpToIndex: 2 }).success).toBe(false);
  });

  it('allows -1 for a pack with no stable prefix', () => {
    expect(ContextPackSchema.safeParse({ ...pack, stableUpToIndex: -1 }).success).toBe(true);
  });

  it('checks the pack against its budget', () => {
    const parsedSpec = ContextPackSpecSchema.parse(spec);
    expect(isWithinBudget(ContextPackSchema.parse(pack), parsedSpec)).toBe(true);
    expect(
      isWithinBudget(
        ContextPackSchema.parse({
          ...pack,
          layers: [{ kind: 'skill-stable', content: 'x', tokens: 500 }],
          totalTokens: 500,
        }),
        parsedSpec,
      ),
    ).toBe(false);
  });

  it('falls back to the max budget when the low tier is unset', () => {
    const parsedSpec = ContextPackSpecSchema.parse(spec);
    const lowPack = ContextPackSchema.parse({ ...pack, effortTier: 'low' });
    expect(isWithinBudget(lowPack, parsedSpec)).toBe(true);
  });
});

describe('memory', () => {
  const base = {
    $schema: SCHEMA_URL,
    work_item_id: 'TASK-001',
    stage: 'implement',
    summary: 'Rolling state for the CSV export task.',
    updated_at: '2026-08-10T00:00:00.000Z',
  };

  it('accepts a well-formed memory file', () => {
    expect(MemorySchema.safeParse(base).success).toBe(true);
  });

  it('rejects an empty or runaway summary', () => {
    expect(MemorySchema.safeParse({ ...base, summary: '' }).success).toBe(false);
    expect(
      MemorySchema.safeParse({ ...base, summary: 'x'.repeat(MEMORY_SUMMARY_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
  });

  it('rejects a stage outside the canonical vocabulary', () => {
    expect(MemorySchema.safeParse({ ...base, stage: 'blocked' }).success).toBe(false);
  });
});

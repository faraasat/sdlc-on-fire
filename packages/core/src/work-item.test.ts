import { describe, expect, it } from 'vitest';
import {
  APPETITE_MEANING,
  BugSchema,
  FeatureSchema,
  TaskSchema,
  WorkItemSchema,
} from './work-item.js';

const SCHEMA_URL = 'https://sdlc-on-fire.dev/schema/work-item.json';

/** A minimal valid task: standard/feature ladder, sitting at `implement`. */
function validTask(overrides: Record<string, unknown> = {}) {
  return {
    $schema: SCHEMA_URL,
    id: 'TASK-001',
    kind: 'task',
    title: 'Add CSV export',
    status: 'In Progress',
    lifecycle_state: 'implement',
    work_type: 'feature',
    preset: 'standard',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    verify: 'pnpm test',
    done: ['tests pass'],
    ...overrides,
  };
}

describe('task frontmatter', () => {
  it('accepts a well-formed task and defaults risk_level to low', () => {
    const parsed = TaskSchema.parse(validTask());
    expect(parsed.risk_level).toBe('low');
    expect(parsed.verify).toBe('pnpm test');
  });

  it('requires verify and done — the daemon has nothing to run without them', () => {
    const { verify: _verify, ...noVerify } = validTask();
    expect(TaskSchema.safeParse(noVerify).success).toBe(false);

    expect(TaskSchema.safeParse(validTask({ done: [] })).success).toBe(false);
  });

  it('rejects an empty verify command', () => {
    expect(TaskSchema.safeParse(validTask({ verify: '' })).success).toBe(false);
  });
});

describe('status is a projection, not an input', () => {
  it('rejects a status that disagrees with lifecycle_state', () => {
    const result = TaskSchema.safeParse(validTask({ status: 'Done' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('status'))).toBe(true);
    }
  });

  it('accepts the derived status', () => {
    expect(
      TaskSchema.safeParse(validTask({ lifecycle_state: 'review', status: 'Review' })).success,
    ).toBe(true);
  });
});

describe('lifecycle_state must be on the item resolved ladder', () => {
  it('rejects a stage absent from the (preset, work_type) subset', () => {
    // security_review exists in the vocabulary but not on the standard ladder.
    const result = TaskSchema.safeParse(
      validTask({ lifecycle_state: 'security_review', status: 'Review' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('lifecycle_state'))).toBe(true);
    }
  });

  it('accepts the same stage under strict, where it is on the ladder', () => {
    expect(
      TaskSchema.safeParse(
        validTask({ preset: 'strict', lifecycle_state: 'security_review', status: 'Review' }),
      ).success,
    ).toBe(true);
  });
});

describe('ADR-0013 link model', () => {
  it('allows either supersedes or corrects', () => {
    expect(TaskSchema.safeParse(validTask({ supersedes: 'TASK-000' })).success).toBe(true);
    expect(TaskSchema.safeParse(validTask({ corrects: 'TASK-000' })).success).toBe(true);
  });

  it('rejects both at once', () => {
    const result = TaskSchema.safeParse(
      validTask({ supersedes: 'TASK-000', corrects: 'TASK-002' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('id and kind must agree', () => {
  it('rejects a task carrying a feature ID', () => {
    const result = TaskSchema.safeParse(validTask({ id: 'FEAT-001' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('id'))).toBe(true);
    }
  });
});

describe('kind-specific requirements', () => {
  it('requires spec_ref and acceptance_criteria on a feature', () => {
    const base = {
      ...validTask(),
      id: 'FEAT-001',
      kind: 'feature',
      acceptance_criteria: ['GIVEN a report WHEN exporting THEN a CSV downloads'],
      spec_ref: 'specs/csv-export/spec.md',
    };
    delete (base as Record<string, unknown>)['verify'];
    delete (base as Record<string, unknown>)['done'];

    expect(FeatureSchema.safeParse(base).success).toBe(true);

    const { spec_ref: _specRef, ...noSpecRef } = base;
    expect(FeatureSchema.safeParse(noSpecRef).success).toBe(false);
  });

  it('requires repro_steps and severity on a bug, on the bug ladder', () => {
    const bug = {
      $schema: SCHEMA_URL,
      id: 'BUG-001',
      kind: 'bug',
      title: 'Export drops the header row',
      status: 'Discovery',
      lifecycle_state: 'triage',
      work_type: 'bug',
      preset: 'standard',
      created_at: '2026-08-10T00:00:00.000Z',
      updated_at: '2026-08-10T00:00:00.000Z',
      repro_steps: ['Open a report', 'Export as CSV'],
      severity: 'high',
    };
    expect(BugSchema.safeParse(bug).success).toBe(true);

    // severity and risk_level are distinct axes; severity is required, risk defaults.
    expect(BugSchema.parse(bug).risk_level).toBe('low');

    const { severity: _severity, ...noSeverity } = bug;
    expect(BugSchema.safeParse(noSeverity).success).toBe(false);
  });
});

describe('discriminated union', () => {
  it('routes by kind', () => {
    const parsed = WorkItemSchema.parse(validTask());
    expect(parsed.kind).toBe('task');
  });

  it('rejects a kind outside the closed enum', () => {
    // "card" is UI vocabulary and must never be a schema value.
    expect(WorkItemSchema.safeParse(validTask({ kind: 'card' })).success).toBe(false);
  });
});

describe('appetite (P1-SKILL-04)', () => {
  const feature = (): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      ...validTask(),
      id: 'FEAT-001',
      kind: 'feature',
      acceptance_criteria: ['GIVEN a report WHEN exporting THEN a CSV downloads'],
      spec_ref: 'specs/csv-export/spec.md',
    };
    delete base['verify'];
    delete base['done'];
    return base;
  };

  it('accepts a declared appetite on a feature', () => {
    expect(FeatureSchema.safeParse({ ...feature(), appetite: 'small-batch' }).success).toBe(true);
  });

  it('is absent rather than defaulted when nobody chose one', () => {
    // A defaulted appetite is one nobody decided, and the entire value of the
    // field is that it was decided.
    const parsed = FeatureSchema.parse(feature());
    expect(parsed.appetite).toBeUndefined();
  });

  it('refuses a value outside the vocabulary', () => {
    expect(FeatureSchema.safeParse({ ...feature(), appetite: '2 weeks' }).success).toBe(false);
  });

  it('states what each appetite buys rather than implying it', () => {
    // The direction of the constraint is the point: an estimate lets scope fix
    // the time, an appetite lets time fix the scope.
    expect(APPETITE_MEANING['small-batch']).toMatch(/cut scope/);
    expect(APPETITE_MEANING['big-batch']).toMatch(/ceiling/);
  });
});

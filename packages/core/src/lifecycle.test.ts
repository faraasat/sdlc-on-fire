import { describe, expect, it } from 'vitest';
import {
  isStageAllowed,
  isTerminalStage,
  kanbanColumnForStage,
  KANBAN_COLUMNS,
  knownWorkTypes,
  LIFECYCLE_STAGES,
  nextStage,
  PRESETS,
  REQUIRED_STAGES,
  resolveRequiredStages,
  WorkTypeSchema,
} from './lifecycle.js';

describe('stage vocabulary', () => {
  it('excludes the cross-cutting overlays', () => {
    // `blocked`/`needs_human` are derived ribbons, never persisted as a stage.
    expect(LIFECYCLE_STAGES).not.toContain('blocked');
    expect(LIFECYCLE_STAGES).not.toContain('needs_human');
  });

  it('treats done, and only done, as terminal', () => {
    const terminal = LIFECYCLE_STAGES.filter(isTerminalStage);
    expect(terminal).toEqual(['done']);
  });
});

describe('kanban projection', () => {
  it('maps every stage to a declared column', () => {
    // A stage with no column would make `status` underivable for that item.
    for (const stage of LIFECYCLE_STAGES) {
      expect(KANBAN_COLUMNS).toContain(kanbanColumnForStage(stage));
    }
  });

  it('collapses several stages into one column', () => {
    // The projection is many-to-one by design (contract §3.4).
    expect(kanbanColumnForStage('implement')).toBe(kanbanColumnForStage('test'));
    expect(kanbanColumnForStage('discovery')).toBe(kanbanColumnForStage('triage'));
  });
});

describe('REQUIRED_STAGES', () => {
  it('ends every resolved ladder at done', () => {
    for (const preset of PRESETS) {
      for (const [workType, stages] of Object.entries(REQUIRED_STAGES[preset])) {
        expect(stages[stages.length - 1], `${preset}/${workType}`).toBe('done');
      }
    }
  });

  it('never repeats a stage within one ladder', () => {
    for (const preset of PRESETS) {
      for (const [workType, stages] of Object.entries(REQUIRED_STAGES[preset])) {
        expect(new Set(stages).size, `${preset}/${workType}`).toBe(stages.length);
      }
    }
  });

  it('draws only from the canonical vocabulary', () => {
    for (const preset of PRESETS) {
      for (const stages of Object.values(REQUIRED_STAGES[preset])) {
        for (const stage of stages) {
          expect(LIFECYCLE_STAGES).toContain(stage);
        }
      }
    }
  });

  it('gates security_review and approval behind strict only', () => {
    for (const preset of ['lite', 'standard'] as const) {
      for (const stages of Object.values(REQUIRED_STAGES[preset])) {
        expect(stages).not.toContain('security_review');
        expect(stages).not.toContain('approval');
      }
    }
  });

  it('defines every work type across all three presets', () => {
    // A work type present under one preset but missing under another would make
    // a preset change silently unresolvable for existing items.
    for (const workType of knownWorkTypes()) {
      for (const preset of PRESETS) {
        expect(resolveRequiredStages(preset, workType), `${preset}/${workType}`).not.toBeNull();
      }
    }
  });

  it('gets monotonically more thorough from lite to strict', () => {
    for (const workType of ['bug', 'feature']) {
      const lite = resolveRequiredStages('lite', workType)?.length ?? 0;
      const standard = resolveRequiredStages('standard', workType)?.length ?? 0;
      const strict = resolveRequiredStages('strict', workType)?.length ?? 0;
      expect(lite).toBeLessThan(standard);
      expect(standard).toBeLessThan(strict);
    }
  });
});

describe('resolution helpers', () => {
  it('returns null for an unregistered pair rather than a default ladder', () => {
    expect(resolveRequiredStages('standard', 'no-such-work-type')).toBeNull();
    expect(isStageAllowed('standard', 'no-such-work-type', 'done')).toBe(false);
  });

  it('rejects a stage outside the resolved subset', () => {
    // lite/feature has no `test` stage at all — absence, not a skippable state.
    expect(isStageAllowed('lite', 'feature', 'implement')).toBe(true);
    expect(isStageAllowed('lite', 'feature', 'test')).toBe(false);
  });

  it('walks the ladder and stops at the end', () => {
    expect(nextStage('lite', 'bug', 'triage')).toBe('implement');
    expect(nextStage('lite', 'bug', 'implement')).toBe('done');
    expect(nextStage('lite', 'bug', 'done')).toBeNull();
  });

  it('returns null when the stage is not on this item ladder', () => {
    expect(nextStage('lite', 'bug', 'security_review')).toBeNull();
  });
});

describe('work_type validation', () => {
  it('validates against the registry rather than a closed enum', () => {
    expect(WorkTypeSchema.safeParse('feature').success).toBe(true);
    expect(WorkTypeSchema.safeParse('new-project').success).toBe(true);
    expect(WorkTypeSchema.safeParse('invented-on-the-spot').success).toBe(false);
  });
});

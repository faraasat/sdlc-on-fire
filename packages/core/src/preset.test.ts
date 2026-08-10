import { describe, expect, it } from 'vitest';
import {
  classifyPreset,
  isHighRiskPath,
  planPresetMigration,
  PresetMigrationError,
} from './preset.js';

describe('high-risk paths', () => {
  it('flags the ADR-0008 areas', () => {
    for (const p of [
      'src/auth/login.ts',
      'app/payments/charge.ts',
      'db/migrations/001.sql',
      'lib/security/x.ts',
    ]) {
      expect(isHighRiskPath(p), p).toBe(true);
    }
  });

  it('leaves ordinary paths alone', () => {
    expect(isHighRiskPath('src/reports/csv.ts')).toBe(false);
  });

  it('does not match a substring inside a longer word', () => {
    expect(isHighRiskPath('src/authoring/editor.ts')).toBe(false);
  });
});

describe('classification', () => {
  it('defaults to standard', () => {
    const decision = classifyPreset({ workType: 'feature' });
    expect(decision.preset).toBe('standard');
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('escalates to strict on high risk_level', () => {
    expect(classifyPreset({ workType: 'feature', riskLevel: 'high' }).preset).toBe('strict');
  });

  it('escalates to strict on a high-risk path', () => {
    const decision = classifyPreset({ workType: 'feature', touchedPaths: ['src/payments/x.ts'] });
    expect(decision.preset).toBe('strict');
    expect(decision.reasons.join()).toContain('high-risk path');
  });

  it('is deterministic', () => {
    const signals = { workType: 'feature', touchedPaths: ['src/auth/a.ts'] };
    expect(classifyPreset(signals)).toEqual(classifyPreset(signals));
  });

  it('honours an explicit request but records it as an override', () => {
    const decision = classifyPreset({ workType: 'feature', requested: 'lite' });
    expect(decision.preset).toBe('lite');
    expect(decision.reasons[0]).toContain('explicitly requested');
  });

  it('warns when a weaker preset is requested on high-risk work', () => {
    // Honoured, but never silent — the reason list is what a reviewer reads.
    const decision = classifyPreset({ workType: 'feature', riskLevel: 'high', requested: 'lite' });
    expect(decision.preset).toBe('lite');
    expect(decision.reasons.join()).toContain('WARNING');
  });

  it('always explains itself', () => {
    for (const signals of [
      { workType: 'feature' },
      { workType: 'bug' },
      { workType: 'feature', riskLevel: 'high' as const },
    ]) {
      expect(classifyPreset(signals).reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('preset migration', () => {
  it('reports added stages when tightening', () => {
    const plan = planPresetMigration('lite', 'strict', 'feature', 'implement');
    expect(plan.addedStages).toContain('security_review');
    expect(plan.addedStages).toContain('approval');
  });

  it('reports removed stages when loosening', () => {
    expect(planPresetMigration('strict', 'lite', 'feature', 'implement').removedStages).toContain(
      'approval',
    );
  });

  it('says whether the current stage survives', () => {
    // Contract §8 open question 1 is undecided, so this reports rather than acts.
    expect(planPresetMigration('strict', 'lite', 'feature', 'approval').currentStageSurvives).toBe(
      false,
    );
    expect(planPresetMigration('lite', 'strict', 'feature', 'implement').currentStageSurvives).toBe(
      true,
    );
  });

  it('refuses a work type with no ladder', () => {
    expect(() => planPresetMigration('lite', 'strict', 'nonsense', 'implement')).toThrow(
      PresetMigrationError,
    );
  });
});

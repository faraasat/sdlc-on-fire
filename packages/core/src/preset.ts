import { z } from 'zod';
import { PRESETS, resolveRequiredStages, type LifecycleStage, type Preset } from './lifecycle.js';
import type { RiskLevel } from './work-item.js';

/**
 * Preset classification and migration (ADR-0008).
 *
 * Three discrete presets, not a continuous risk score — ADR-0008 rejected
 * continuous scoring for v1 because a number nobody can explain is worse than a
 * label everyone can argue with.
 *
 * Classification is **deterministic** (ADR-0040): the inputs are facts about the
 * work item, and the same inputs always yield the same preset. A model may
 * propose the signals; it does not pick the preset.
 */

/** Paths whose blast radius justifies the strictest ladder, per ADR-0008. */
export const HIGH_RISK_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)auth(entication|orization)?\//i,
  /(^|\/)payments?\//i,
  /(^|\/)billing\//i,
  /(^|\/)migrations?\//i,
  /(^|\/)security\//i,
  /(^|\/)crypto\//i,
];

export interface PresetSignals {
  readonly workType: string;
  readonly riskLevel?: RiskLevel | undefined;
  /** Paths the work is expected to touch, when known at creation time. */
  readonly touchedPaths?: readonly string[] | undefined;
  /** An explicit request overrides classification, but never silently. */
  readonly requested?: Preset | undefined;
}

export interface PresetDecision {
  readonly preset: Preset;
  /** Why this preset, in the order the rules fired. Surfaced to the user, not just logged. */
  readonly reasons: readonly string[];
}

/** Whether a path falls in a high-risk area (ADR-0008's auth/payments/migration rule). */
export function isHighRiskPath(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  return HIGH_RISK_PATH_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Picks a preset from work-item signals.
 *
 * An explicit `requested` preset wins, but is recorded as an override in
 * `reasons` — the user's choice is honoured, and the fact that it *was* a choice
 * survives into the audit trail rather than looking like the system's judgment.
 */
export function classifyPreset(signals: PresetSignals): PresetDecision {
  const reasons: string[] = [];

  const highRisk =
    signals.riskLevel === 'high' ||
    (signals.touchedPaths ?? []).some((path) => isHighRiskPath(path));

  if (highRisk) {
    reasons.push(
      signals.riskLevel === 'high'
        ? 'risk_level is high'
        : 'touches a high-risk path (auth / payments / migrations / security)',
    );
  }

  if (signals.requested !== undefined) {
    reasons.unshift(`explicitly requested "${signals.requested}"`);
    // A deliberate downgrade away from strict on high-risk work is allowed but
    // never silent: the reason list is what a reviewer reads later.
    if (highRisk && signals.requested !== 'strict') {
      reasons.push('WARNING: high-risk signals present but a weaker preset was requested');
    }
    return { preset: signals.requested, reasons };
  }

  if (highRisk) return { preset: 'strict', reasons };

  if (signals.workType === 'bug') {
    reasons.push('bugs default to the standard ladder');
    return { preset: 'standard', reasons };
  }

  reasons.push('no elevated-risk signal; standard is the default');
  return { preset: 'standard', reasons };
}

export class PresetMigrationError extends Error {
  override readonly name = 'PresetMigrationError';
  constructor(message: string) {
    super(message);
  }
}

export interface PresetMigration {
  readonly from: Preset;
  readonly to: Preset;
  /** Stages the item will now be required to pass that it was not before. */
  readonly addedStages: readonly LifecycleStage[];
  /** Stages no longer required. */
  readonly removedStages: readonly LifecycleStage[];
  /** True when the item's current stage survives the change. */
  readonly currentStageSurvives: boolean;
}

/**
 * Describes what changing an item's preset would do, without doing it.
 *
 * Contract §8 open question 1 asks what happens to an item mid-lifecycle when
 * its required-stage list changes, and does **not** answer it. This function
 * therefore *reports* rather than decides: it surfaces the added and removed
 * stages and whether the current stage survives, so a caller (or a human) can
 * make the call. Silently inserting a stage as retroactively-satisfied would be
 * exactly the unexamined answer the contract declined to give.
 */
export function planPresetMigration(
  from: Preset,
  to: Preset,
  workType: string,
  currentStage: LifecycleStage,
): PresetMigration {
  const before = resolveRequiredStages(from, workType);
  const after = resolveRequiredStages(to, workType);

  if (before === null || after === null) {
    throw new PresetMigrationError(
      `no stage ladder for work_type "${workType}" under preset "${before === null ? from : to}"`,
    );
  }

  return {
    from,
    to,
    addedStages: after.filter((stage) => !before.includes(stage)),
    removedStages: before.filter((stage) => !after.includes(stage)),
    currentStageSurvives: after.includes(currentStage),
  };
}

export const PresetDecisionSchema = z.object({
  preset: z.enum(PRESETS),
  reasons: z.array(z.string().min(1)).min(1),
});

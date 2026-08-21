/**
 * Card progress, as dots (P3-KAN-02).
 *
 * A card's required stages are already resolved per preset and work type
 * ({@link resolveRequiredStages}), and its transition history says which it has
 * been through. Together those are a progress indicator that is *derived from
 * what happened* rather than from a percentage somebody typed.
 *
 * The distinction the dots must preserve is between **not yet reached** and
 * **reached and not passing**. A percentage bar collapses those into one number
 * and makes a blocked card at 80% look better than a healthy card at 60%,
 * which is exactly backwards.
 */

import { PRESETS, resolveRequiredStages, type LifecycleStage, type Preset } from './lifecycle.js';

export const DOT_STATES = ['done', 'current', 'pending', 'skipped'] as const;
export type DotState = (typeof DOT_STATES)[number];

export interface ProgressDot {
  readonly stage: LifecycleStage;
  readonly state: DotState;
  /** True when the card has been through this stage more than once. */
  readonly revisited: boolean;
}

export interface CardProgress {
  readonly dots: readonly ProgressDot[];
  readonly doneCount: number;
  readonly total: number;
  /** Stages the card passed through that its preset does not require. */
  readonly extra: readonly string[];
}

/**
 * Derive the dots for one card.
 *
 * `visitedStages` is the ordered history, so a stage the card returned to is
 * marked `revisited` rather than merely `done`. Rework is the signal a progress
 * bar most reliably hides — a card on its third pass through `implement` shows
 * identical progress to one on its first.
 *
 * A required stage that the card skipped past shows as `skipped`, not `done`.
 * The lifecycle should prevent that, and if it ever happens the dots are where
 * somebody will see it.
 */
export function cardProgress(
  currentStage: string,
  visitedStages: readonly string[],
  preset: string,
  workType: string,
): CardProgress {
  // Checked before the lookup, not after. `resolveRequiredStages` indexes
  // `REQUIRED_STAGES[preset]` directly and throws on a preset it does not know,
  // so an unrecognised value from a hand-edited frontmatter file would take the
  // whole drawer down rather than render an empty ladder.
  const known = (PRESETS as readonly string[]).includes(preset);
  const required = known ? (resolveRequiredStages(preset as Preset, workType) ?? []) : [];
  const visitCount = new Map<string, number>();
  for (const stage of visitedStages) visitCount.set(stage, (visitCount.get(stage) ?? 0) + 1);

  const currentIndex = required.indexOf(currentStage as LifecycleStage);

  const dots: ProgressDot[] = required.map((stage, index) => {
    const visits = visitCount.get(stage) ?? 0;
    const revisited = visits > 1;

    if (stage === currentStage) return { stage, state: 'current', revisited };
    if (visits > 0) return { stage, state: 'done', revisited };
    // Before the current stage but never visited: the card jumped over it.
    if (currentIndex >= 0 && index < currentIndex) return { stage, state: 'skipped', revisited };
    return { stage, state: 'pending', revisited };
  });

  return {
    dots,
    doneCount: dots.filter((dot) => dot.state === 'done').length,
    total: required.length,
    extra: [...visitCount.keys()].filter(
      (stage) => !(required as readonly string[]).includes(stage),
    ),
  };
}

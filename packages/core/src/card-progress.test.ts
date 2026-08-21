import { describe, expect, it } from 'vitest';
import { cardProgress } from './card-progress.js';
import { resolveRequiredStages } from './lifecycle.js';

/**
 * P3-KAN-02 — progress dots.
 *
 * Dots rather than a percentage because a percentage collapses "not yet
 * reached" into "not passing", which makes a blocked card at 80% look better
 * than a healthy card at 60%.
 */

const REQUIRED = resolveRequiredStages('standard', 'feature') ?? [];

describe('cardProgress', () => {
  it('marks the current stage, what came before it, and what has not happened', () => {
    const first = REQUIRED[0] as string;
    const second = REQUIRED[1] as string;
    const progress = cardProgress(second, [first, second], 'standard', 'feature');

    expect(progress.dots.find((dot) => dot.stage === first)?.state).toBe('done');
    expect(progress.dots.find((dot) => dot.stage === second)?.state).toBe('current');
    expect(progress.dots.at(-1)?.state).toBe('pending');
  });

  it('flags a stage the card has been through more than once', () => {
    // Rework is what a progress bar most reliably hides: a card on its third
    // pass through implement shows identical progress to one on its first.
    const first = REQUIRED[0] as string;
    const second = REQUIRED[1] as string;
    const progress = cardProgress(second, [first, second, first, second], 'standard', 'feature');
    expect(progress.dots.find((dot) => dot.stage === first)?.revisited).toBe(true);
  });

  it('shows a jumped-over required stage as skipped, not as done', () => {
    // The lifecycle should prevent this. If it ever happens, the dots are where
    // somebody sees it — rendering it as done would hide the one thing worth
    // knowing about that card.
    const third = REQUIRED[2] as string;
    const progress = cardProgress(third, [third], 'standard', 'feature');
    expect(progress.dots[0]?.state).toBe('skipped');
    expect(progress.dots[1]?.state).toBe('skipped');
  });

  it('counts only genuinely completed stages', () => {
    const first = REQUIRED[0] as string;
    const progress = cardProgress(first, [first], 'standard', 'feature');
    expect(progress.doneCount).toBe(0);
    expect(progress.total).toBe(REQUIRED.length);
  });

  it('reports stages visited that the preset does not require', () => {
    // A card that went through security_review under a preset that does not
    // ask for it did more than required, which is worth showing rather than
    // discarding.
    const progress = cardProgress(
      REQUIRED[0] as string,
      [REQUIRED[0] as string, 'security_review'],
      'standard',
      'feature',
    );
    expect(progress.extra).toContain('security_review');
  });

  it('handles a card that has been nowhere', () => {
    const progress = cardProgress('', [], 'standard', 'feature');
    expect(progress.doneCount).toBe(0);
    expect(progress.dots.every((dot) => dot.state === 'pending')).toBe(true);
  });

  it('returns an empty ladder for a preset it does not know, rather than inventing one', () => {
    const progress = cardProgress('spec', ['spec'], 'nonsense-preset', 'feature');
    expect(progress.total).toBe(0);
    expect(progress.dots).toEqual([]);
  });

  it('tracks the preset, so a lite card is not judged against strict', () => {
    const lite = cardProgress('spec', ['spec'], 'lite', 'feature');
    const strict = cardProgress('spec', ['spec'], 'strict', 'feature');
    expect(lite.total).toBeLessThanOrEqual(strict.total);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { KANBAN_COLUMNS, LIFECYCLE_STAGES } from '@sdlc-on-fire/core';
import { isNoOpMove, moveCard, stageForDrop, stagesInColumn } from './move.js';

/**
 * P3-KAN-01 — what a drag means.
 *
 * Columns project many stages onto one label, so a drop is ambiguous by
 * construction and the resolution has to be a stated rule rather than whatever
 * the implementation happened to do.
 */

describe('stagesInColumn', () => {
  it('lists the stages a column projects from, in lifecycle order', () => {
    const inProgress = stagesInColumn('In Progress');
    expect(inProgress).toContain('implement');
    expect(inProgress).toContain('test');
    expect(inProgress.indexOf('implement')).toBeLessThan(inProgress.indexOf('test'));
  });

  it('covers every stage across every column, losing none', () => {
    // A stage belonging to no column would be a card the board cannot show.
    const covered = KANBAN_COLUMNS.flatMap((column) => stagesInColumn(column));
    expect([...covered].sort()).toEqual([...LIFECYCLE_STAGES].sort());
  });

  it('is empty for something that is not a column', () => {
    expect(stagesInColumn('Nonsense')).toEqual([]);
  });
});

describe('stageForDrop', () => {
  it('resolves to the earliest stage of the column, never the latest', () => {
    // Resolving to the last stage would let a drag skip `implement` and land on
    // `test` — the quiet stage-skipping the lifecycle exists to prevent.
    expect(stageForDrop('In Progress')).toBe('implement');
  });

  it('returns null rather than guessing at an unknown column', () => {
    expect(stageForDrop('Somewhere Else')).toBeNull();
  });

  it('resolves every real column to a real stage', () => {
    for (const column of KANBAN_COLUMNS) {
      expect(stageForDrop(column), column).not.toBeNull();
    }
  });
});

describe('isNoOpMove', () => {
  it('recognises a drop back into the card’s own column', () => {
    // The most common accidental gesture on a board. Treating it as a
    // transition writes a history row saying work moved when it did not.
    expect(isNoOpMove('implement', 'In Progress')).toBe(true);
    expect(isNoOpMove('test', 'In Progress')).toBe(true);
  });

  it('is false for a genuine move', () => {
    expect(isNoOpMove('implement', 'Review')).toBe(false);
  });

  it('is false for a stage it does not know, so the move is attempted and refused properly', () => {
    expect(isNoOpMove('from_the_future', 'In Progress')).toBe(false);
  });
});

describe('moveCard', () => {
  const noop = (): Promise<void> => Promise.resolve();
  const deps = (stage: string | null, transition = vi.fn(noop)) => ({
    currentStage: () => Promise.resolve(stage),
    transition,
  });

  it('transitions through the engine, not around it', async () => {
    // Asserted against `stagesInColumn` rather than the literal `'review'`,
    // which was the first version and was wrong: the Review column projects
    // from `security_review` first. Pinning the literal would have encoded a
    // guess about the stage ladder into a test about delegation, and it would
    // break the day a stage is inserted — for a reason that has nothing to do
    // with what this test is checking.
    const transition = vi.fn(noop);
    const outcome = await moveCard(deps('implement', transition), 'FEAT-1', 'Review');
    expect(outcome.moved).toBe(true);
    expect(transition).toHaveBeenCalledWith('FEAT-1', stagesInColumn('Review')[0]);
  });

  it('does nothing at all for a drop into the same column', async () => {
    const transition = vi.fn(noop);
    const outcome = await moveCard(deps('implement', transition), 'FEAT-1', 'In Progress');
    expect(outcome.moved).toBe(false);
    expect(transition).not.toHaveBeenCalled();
    expect(outcome.because).toContain('already in that column');
  });

  it('reports a refusal in the guard’s own words', async () => {
    // A refused move is the normal case this product is built around. The
    // user needs the gate's reason, and rewriting it here would invent a second
    // vocabulary for refusal alongside the CLI's.
    const transition = vi.fn((): Promise<void> =>
      Promise.reject(new Error('gate `tests` has not passed on FEAT-1')),
    );
    const outcome = await moveCard(deps('implement', transition), 'FEAT-1', 'Review');
    expect(outcome.moved).toBe(false);
    expect(outcome.because).toContain('gate `tests` has not passed');
  });

  it('reports an unknown card rather than throwing', async () => {
    const outcome = await moveCard(deps(null), 'GHOST', 'Review');
    expect(outcome.moved).toBe(false);
    expect(outcome.because).toContain('GHOST');
  });

  it('refuses a column that is not a column', async () => {
    const transition = vi.fn(noop);
    const outcome = await moveCard(deps('implement', transition), 'FEAT-1', 'Trash');
    expect(outcome.moved).toBe(false);
    expect(transition).not.toHaveBeenCalled();
  });
});

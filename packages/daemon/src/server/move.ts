/**
 * Moving a card from the board (P3-KAN-01).
 *
 * The one write the UI performs, and it goes through {@link LifecycleEngine} —
 * the same object `sdlc advance` drives. That is the whole design: a drag is a
 * *proposal*, and the engine's guards dispose of it. A second transition path
 * that skipped them would let dragging a card do what the CLI refuses, and the
 * board would become the way around the gates rather than a view of them.
 *
 * The column-to-stage step is where the ambiguity lives. Columns are a
 * projection of many stages onto one label — `implement` and `test` are both
 * "In Progress" — so a drop names a column and the daemon picks the stage.
 */

import { isNoOpMove, stageForDrop, type LifecycleStage } from '@sdlc-on-fire/core';

// Re-exported so existing importers keep working; the definitions live in core
// because the browser needs the identical answer for its optimistic paint.
export { isNoOpMove, stageForDrop, stagesInColumn } from '@sdlc-on-fire/core';

export interface MoveOutcome {
  readonly moved: boolean;
  readonly from: string;
  readonly to: string | null;
  readonly because: string;
}

export interface MoveDeps {
  readonly currentStage: (id: string) => Promise<string | null>;
  readonly transition: (id: string, to: LifecycleStage) => Promise<void>;
}

/**
 * Resolve and perform a board move.
 *
 * Refusals come back as outcomes rather than as thrown errors, because a
 * refused move is the *normal* case this product is built around — the gate
 * said no — and the user needs the reason on the card, not a stack trace.
 */
export async function moveCard(
  deps: MoveDeps,
  cardId: string,
  column: string,
): Promise<MoveOutcome> {
  const from = await deps.currentStage(cardId);
  if (from === null) {
    return { moved: false, from: '', to: null, because: `no work item ${cardId}` };
  }

  if (isNoOpMove(from, column)) {
    return { moved: false, from, to: null, because: 'already in that column' };
  }

  const to = stageForDrop(column);
  if (to === null) {
    return { moved: false, from, to: null, because: `${column} is not a board column` };
  }

  try {
    await deps.transition(cardId, to);
    return { moved: true, from, to, because: `moved to ${to}` };
  } catch (error) {
    // The guard's own words. Rewriting them here would produce a second
    // vocabulary for refusal, and the CLI's message is the one users will have
    // already seen.
    return {
      moved: false,
      from,
      to,
      because: error instanceof Error ? error.message : String(error),
    };
  }
}

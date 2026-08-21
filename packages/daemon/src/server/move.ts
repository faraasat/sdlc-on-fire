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

import {
  KANBAN_COLUMNS,
  kanbanColumnForStage,
  LIFECYCLE_STAGES,
  type KanbanColumn,
  type LifecycleStage,
} from '@sdlc-on-fire/core';

/** The stages a column projects from, in lifecycle order. */
export function stagesInColumn(column: string): readonly LifecycleStage[] {
  if (!(KANBAN_COLUMNS as readonly string[]).includes(column)) return [];
  return LIFECYCLE_STAGES.filter(
    (stage) => kanbanColumnForStage(stage) === (column as KanbanColumn),
  );
}

/**
 * Which stage a drop onto a column means.
 *
 * The *earliest* stage of the target column, always — never the latest and
 * never "whichever is legal". Dropping a card on "In Progress" means it is
 * starting that phase, and resolving to the last stage would let a drag skip
 * `implement` and land straight on `test`, which is exactly the kind of quiet
 * stage-skipping the lifecycle exists to prevent.
 *
 * Returns null for a column that is not a column, rather than guessing.
 */
export function stageForDrop(column: string): LifecycleStage | null {
  return stagesInColumn(column)[0] ?? null;
}

/**
 * Whether a drop is a no-op — the card is already somewhere in that column.
 *
 * Worth its own answer. Dragging a card two pixels inside its own column is the
 * most common accidental gesture on a board, and treating it as a transition
 * would write a lifecycle_transitions row saying work moved when it did not,
 * into a table this project treats as history rather than as a mirror.
 */
export function isNoOpMove(currentStage: string, column: string): boolean {
  if (!(LIFECYCLE_STAGES as readonly string[]).includes(currentStage)) return false;
  return kanbanColumnForStage(currentStage as LifecycleStage) === column;
}

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

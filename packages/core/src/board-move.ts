/**
 * What a drop onto a column means (P3-KAN-01, P3-RT-02).
 *
 * In core rather than in the daemon because **both sides need the same answer**.
 * The daemon resolves a drop into a lifecycle transition; the browser paints the
 * card optimistically before the daemon replies. Two implementations of "which
 * stage is this column" would disagree the moment a stage is inserted, and the
 * symptom would be a card that visibly lands in one place and then moves to
 * another — which reads as a bug in the drag rather than as a disagreement
 * between two copies of one rule.
 */

import {
  KANBAN_COLUMNS,
  kanbanColumnForStage,
  LIFECYCLE_STAGES,
  type KanbanColumn,
  type LifecycleStage,
} from './lifecycle.js';

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

import { useMemo, type ReactElement } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  projectBoard,
  unplaceable,
  type BoardCard,
  type GroupBy,
} from '@sdlc-on-fire/core/browser';
import { Column } from './Column.js';

/**
 * The board (P3-KAN-01).
 *
 * The projection is `projectBoard` in core, not logic living in this render.
 * What is here is the part that genuinely needs a browser: drag, and the two
 * sensors that make it usable.
 *
 * The keyboard sensor is not an accessibility afterthought. Dragging is the
 * board's primary verb, and a primary verb available only to a mouse is a board
 * a keyboard user cannot operate at all.
 */
export function BoardView({
  cards,
  groupBy,
  filter,
  onMove,
  onClearFilters,
}: {
  cards: readonly BoardCard[];
  groupBy: GroupBy;
  filter: { text: string; risk: string | null; blockedOnly: boolean; needsHumanOnly: boolean };
  onMove: (cardId: string, column: string) => void;
  onClearFilters: () => void;
}): ReactElement {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  const board = useMemo(() => projectBoard(cards, { groupBy, filter }), [cards, groupBy, filter]);
  const stranded = useMemo(() => unplaceable(cards), [cards]);
  const visible = board.columns.reduce((sum, column) => sum + column.total, 0);

  return (
    <>
      {stranded.length > 0 ? (
        // Named rather than dropped. An unknown stage means the workspace and
        // this build disagree, and a card silently vanishing is the worst way
        // to discover that.
        <p className="warn" role="status">
          {stranded.length} card(s) have a lifecycle stage this build does not know (
          {stranded.map((card) => card.id).join(', ')}) — they are not shown on the board. Your
          workspace may be newer than this CLI.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        onDragEnd={(event: DragEndEvent) => {
          const cardId = String(event.active.id);
          const column = event.over === null ? null : String(event.over.id);
          if (column !== null) onMove(cardId, column);
        }}
      >
        <div className="kboard">
          {board.columns.map((column) => (
            <Column key={column.column} column={column} />
          ))}
        </div>
      </DndContext>

      {visible === 0 && board.hidden > 0 ? (
        // Rendered here rather than in the shell. The board's projection is
        // what applies the filter, so it is the only thing that knows the
        // result is empty — the shell sees a non-empty card list and would
        // show a board of seven empty columns with no explanation.
        <p className="muted">
          nothing matches this filter.{' '}
          <button type="button" onClick={onClearFilters}>
            clear it
          </button>
        </p>
      ) : board.hidden > 0 ? (
        <p className="muted">{board.hidden} card(s) hidden by the current filter.</p>
      ) : null}
    </>
  );
}

import type { ReactElement } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { isBlocked, needsHuman, type BoardCard } from '@sdlc-on-fire/core/browser';

/**
 * One card (P3-KAN-01).
 *
 * The overlays are the reason a board beats a list. A failing gate and a lease
 * that quietly expired are both "this is not moving", and neither is visible
 * from a title — so they are shown on the face rather than behind a click.
 */
export function Card({ card }: { card: BoardCard }): ReactElement {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });

  const blocked = isBlocked(card);
  const human = needsHuman(card);

  return (
    <article
      ref={setNodeRef}
      className={`kcard${isDragging ? ' kcard--dragging' : ''}${blocked ? ' kcard--blocked' : ''}`}
      // The keyboard sensor needs a focusable, labelled handle. A board that
      // can only be operated with a mouse excludes people outright, and it is
      // also the first thing an axe-core run fails on (P3-UI-03).
      {...attributes}
      {...listeners}
      aria-roledescription="draggable card"
      aria-label={`${card.id}: ${card.title}`}
    >
      <header className="kcard__head">
        <code>{card.id}</code>
        {card.active_run != null ? (
          <span className="chip chip--live" title={`run ${card.active_run} is executing`}>
            <i aria-hidden="true" /> running
          </span>
        ) : null}
      </header>

      <p className="kcard__title">{card.title}</p>

      <footer className="kcard__tags">
        {card.gate_state != null ? (
          <span className={`chip chip--gate chip--${card.gate_state}`}>gate {card.gate_state}</span>
        ) : (
          // Distinguished from a pass. A card nothing has checked has not
          // passed anything — the distinction this product exists for.
          <span className="chip chip--none" title="no gate has run on this card">
            ungated
          </span>
        )}
        {blocked ? <span className="chip chip--blocked">blocked</span> : null}
        {human ? <span className="chip chip--human">needs a human</span> : null}
        {card.risk_level != null ? <span className="chip">{card.risk_level}</span> : null}
      </footer>
    </article>
  );
}

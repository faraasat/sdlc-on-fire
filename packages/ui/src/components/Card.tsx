import type { ReactElement } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { actorBadge, isBlocked, needsHuman, type BoardCard } from '@sdlc-on-fire/core/browser';
import { useUiStore } from '../state/ui.js';

/**
 * One card (P3-KAN-01).
 *
 * The overlays are the reason a board beats a list. A failing gate and a lease
 * that quietly expired are both "this is not moving", and neither is visible
 * from a title — so they are shown on the face rather than behind a click.
 */
export function Card({ card }: { card: BoardCard }): ReactElement {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: card.id,
  });

  const select = useUiStore((state) => state.select);

  const blocked = isBlocked(card);
  const human = needsHuman(card);

  return (
    <article
      ref={setNodeRef}
      className={`kcard${isDragging ? ' kcard--dragging' : ''}${blocked ? ' kcard--blocked' : ''}`}
      aria-label={`${card.id}: ${card.title}`}
    >
      <header className="kcard__head">
        {/*
          A dedicated drag handle, sibling to the open control rather than
          wrapping it. The first version spread dnd-kit's `attributes` and
          `listeners` onto the whole <article>, which gives it role="button" and
          tabIndex=0 — so the open-details button sat *inside* a button. axe
          flags that as `nested-interactive` on its first run, and it is a real
          problem rather than a lint: a screen-reader user meets a button inside
          a button and the inner one may be unreachable.

          Two siblings also make the interaction honest. Grab the handle to move
          the card; click the id to read it.
        */}
        <button
          type="button"
          className="kcard__grip"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`drag ${card.id}`}
          title="drag to move"
        >
          <span aria-hidden="true">⠿</span>
        </button>

        <button
          type="button"
          className="kcard__open"
          onClick={() => select(card.id)}
          aria-label={`open details for ${card.id}`}
        >
          <code>{card.id}</code>
        </button>

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
        {/*
          Who holds the card, and whether they are a person. "Agents are actors,
          never approvers" is a rule that lives in the database and dies on the
          screen — everything anyone knows about who did what comes from what
          they can see, so an agent is marked here rather than rendered as a
          teammate indistinguishable from a colleague (P3-RBAC-09).
        */}
        {card.claimed_by == null ? null : (
          <span
            className={`chip chip--claim${card.claim_kind === 'agent' ? ' chip--agent' : ''}`}
            title={
              actorBadge({
                id: card.claimed_by,
                kind: card.claim_kind === 'agent' ? 'agent' : 'human',
                displayName: card.claimed_by,
              }).title
            }
          >
            {
              actorBadge({
                id: card.claimed_by,
                kind: card.claim_kind === 'agent' ? 'agent' : 'human',
                displayName: card.claimed_by,
              }).label
            }
          </span>
        )}
      </footer>
    </article>
  );
}

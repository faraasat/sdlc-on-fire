import type { ReactElement } from 'react';
import { isBlocked, needsHuman, type BoardCard } from '@sdlc-on-fire/core/browser';

/**
 * The table view (P3-KAN-01).
 *
 * A real `<table>` with real headers, not a grid of divs. Screen readers
 * announce row and column relationships from the markup, and a div grid gives
 * them nothing — which turns "scan the board" into "read 200 unrelated
 * fragments".
 */
export function TableView({ cards }: { cards: readonly BoardCard[] }): ReactElement {
  return (
    <table className="ktable">
      <caption className="sr-only">Work items</caption>
      <thead>
        <tr>
          <th scope="col">ID</th>
          <th scope="col">Title</th>
          <th scope="col">Stage</th>
          <th scope="col">Gate</th>
          <th scope="col">Risk</th>
          <th scope="col">State</th>
        </tr>
      </thead>
      <tbody>
        {cards.map((card) => (
          <tr key={card.id}>
            <th scope="row">
              <code>{card.id}</code>
            </th>
            <td>{card.title}</td>
            <td>{card.lifecycle_state}</td>
            <td>{card.gate_state ?? 'ungated'}</td>
            <td>{card.risk_level ?? '—'}</td>
            <td>{isBlocked(card) ? 'blocked' : needsHuman(card) ? 'needs a human' : 'moving'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

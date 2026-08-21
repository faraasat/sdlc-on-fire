import type { ReactElement } from 'react';
import {
  KANBAN_COLUMNS,
  kanbanColumnForStage,
  isKnownStage,
  type BoardCard,
} from '@sdlc-on-fire/core/browser';

/**
 * The roadmap view (P3-KAN-01).
 *
 * Epics as rows, columns as progress. Deliberately not a Gantt chart: nothing
 * in this product records a planned start or end date, and drawing a timeline
 * from data that does not exist would be inventing schedule confidence — the
 * single most load-bearing lie in project software.
 */
export function RoadmapView({ cards }: { cards: readonly BoardCard[] }): ReactElement {
  const epics = new Map<string, BoardCard[]>();
  for (const card of cards) {
    const key = card.parent_id ?? '(no epic)';
    epics.set(key, [...(epics.get(key) ?? []), card]);
  }

  return (
    <div className="kroadmap">
      <p className="muted">
        Progress by epic. There are no dates here because nothing records a planned start or end — a
        timeline drawn from that would be a guess wearing a chart.
      </p>
      {[...epics.entries()].map(([epic, members]) => {
        const counts = KANBAN_COLUMNS.map(
          (column) =>
            members.filter(
              (card) =>
                isKnownStage(card.lifecycle_state) &&
                kanbanColumnForStage(card.lifecycle_state) === column,
            ).length,
        );
        const total = members.length;
        return (
          <section key={epic} className="kroadmap__row">
            <h3>
              {epic} <small>{total} card(s)</small>
            </h3>
            <div
              className="kroadmap__bar"
              role="img"
              aria-label={`${epic}: ${String(total)} cards`}
            >
              {KANBAN_COLUMNS.map((column, index) => {
                const count = counts[index] ?? 0;
                if (count === 0) return null;
                return (
                  <span
                    key={column}
                    className={`kroadmap__seg kroadmap__seg--${column.replace(/\s+/g, '-').toLowerCase()}`}
                    style={{ flexGrow: count }}
                    title={`${column}: ${String(count)}`}
                  >
                    {count}
                  </span>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

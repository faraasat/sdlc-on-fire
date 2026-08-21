import { useRef, type ReactElement } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { BoardColumn } from '@sdlc-on-fire/core/browser';
import { Card } from './Card.js';

/** Past this many cards the column virtualizes rather than rendering everything. */
export const VIRTUALIZE_ABOVE = 50;

/**
 * One column (P3-KAN-01).
 *
 * Virtualized only past a threshold. Virtualization is not free — it costs a
 * scroll container, measured rows, and a class of bug where the thing you are
 * looking for is not in the DOM — so a column with eleven cards renders them
 * plainly and a column with four hundred does not lock the tab.
 */
export function Column({ column }: { column: BoardColumn }): ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: column.column });
  const scrollRef = useRef<HTMLDivElement>(null);

  const flat = column.lanes.flatMap((lane) =>
    lane.key === ''
      ? lane.cards.map((card) => ({ kind: 'card' as const, card }))
      : [
          { kind: 'lane' as const, lane },
          ...lane.cards.map((card) => ({ kind: 'card' as const, card })),
        ],
  );

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 92,
    overscan: 8,
    enabled: flat.length > VIRTUALIZE_ABOVE,
  });

  const virtualized = flat.length > VIRTUALIZE_ABOVE;

  return (
    <section
      ref={setNodeRef}
      className={`kcol${isOver ? ' kcol--over' : ''}`}
      aria-label={`${column.column}, ${String(column.total)} cards`}
    >
      <header className="kcol__head">
        <h2>{column.column}</h2>
        <span className="kcol__count">{column.total}</span>
      </header>

      <div className="kcol__scroll" ref={scrollRef}>
        {virtualized ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const entry = flat[row.index];
              if (entry === undefined) return null;
              return (
                <div
                  key={row.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${String(row.start)}px)`,
                  }}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                >
                  {entry.kind === 'lane' ? (
                    <h3 className={`klane${entry.lane.isOverflow ? ' klane--overflow' : ''}`}>
                      {entry.lane.label}
                    </h3>
                  ) : (
                    <Card card={entry.card} />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          flat.map((entry, index) =>
            entry.kind === 'lane' ? (
              <h3
                key={`lane-${entry.lane.key}-${String(index)}`}
                className={`klane${entry.lane.isOverflow ? ' klane--overflow' : ''}`}
              >
                {entry.lane.label}
              </h3>
            ) : (
              <Card key={entry.card.id} card={entry.card} />
            ),
          )
        )}

        {column.total === 0 ? <p className="kcol__empty">nothing here</p> : null}
      </div>
    </section>
  );
}

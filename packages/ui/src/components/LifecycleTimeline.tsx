import type { ReactElement } from 'react';
import type { TimelineResponse } from '../api/client.js';

/**
 * A card's stage history (P6-SURFACE-04, FEAT-UI-002).
 *
 * The board shows where a card *is*. This answers the question people actually
 * arrive with about a card that went wrong, which is how it got there.
 *
 * Rendering only — the projection is `lifecycleTimeline` in core, so what this
 * view claims about a card's history is testable without a browser.
 */

export interface LifecycleTimelineProps {
  readonly timeline: TimelineResponse | undefined;
  readonly loading?: boolean;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${String(Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${String(Math.round(hours))}h`;
  return `${String(Math.round(hours / 24))}d`;
}

export function LifecycleTimeline({
  timeline,
  loading = false,
}: LifecycleTimelineProps): ReactElement {
  if (loading) return <p className="timeline__empty">loading…</p>;
  if (timeline === undefined) return <p className="timeline__empty">no timeline</p>;

  // A payload that is not a timeline is a server problem, and it says so here
  // rather than throwing. The drawer's other sections — gates, comments, runs —
  // have nothing to do with this endpoint, and taking all of them down because
  // one response was malformed turns a narrow fault into a blank panel.
  //
  // Checked through an `unknown` alias so the guard does not widen the typed
  // field to `any` for everything below it — `Array.isArray` narrows *away*
  // from the declared type, which is the opposite of what is wanted here.
  const rawEntries: unknown = timeline.entries;
  if (!Array.isArray(rawEntries)) {
    return <p className="timeline__empty">timeline unavailable — the server sent no entries</p>;
  }

  if (timeline.entries.length === 0) {
    return <p className="timeline__empty">{timeline.because}</p>;
  }

  return (
    <section className="timeline" aria-label="Lifecycle timeline">
      <p className="timeline__summary">{timeline.because}</p>
      <ol className="timeline__list">
        {timeline.entries.map((entry, index) => (
          <li
            key={`${entry.stage}-${String(entry.enteredAt)}-${String(index)}`}
            className={entry.reentry ? 'timeline__item timeline__item--rework' : 'timeline__item'}
          >
            <span className="timeline__stage">{entry.stage}</span>
            {/* Only on a re-entry: labelling every first visit "visit 1" makes
                the rework harder to spot, not easier. */}
            {entry.reentry ? <span className="timeline__visit">visit {entry.visit}</span> : null}
            <span className="timeline__duration">{duration(entry.ms)}</span>
            {entry.leftAt === null ? <span className="timeline__open">still here</span> : null}
            {/* Shown, never hidden: an unattributed move is a fact about the
                record, and a blank would read as an oversight in the view. */}
            <span className="timeline__actor">{entry.actor ?? '(system)'}</span>
            {entry.insertions.length > 0 ? (
              <ul className="timeline__insertions">
                {entry.insertions.map((marker) => (
                  <li key={marker.insertionId}>
                    <strong>{marker.insertionId}</strong> {marker.summary}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      {timeline.unplacedInsertions.length > 0 ? (
        <p className="timeline__unplaced">
          {timeline.unplacedInsertions.length} insertion(s) fall outside every visit — their
          timestamps disagree with the transitions.
        </p>
      ) : null}

      {/* "Nobody looked" is not "there were none", and a view that rendered them
          the same way would make a missing reader invisible. */}
      {timeline.insertionsAvailable ? null : (
        <p className="timeline__unavailable">
          Insertion markers unavailable — this server has no insertion reader.
        </p>
      )}
    </section>
  );
}

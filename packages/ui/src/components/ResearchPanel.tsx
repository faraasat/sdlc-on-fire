import type { ReactElement } from 'react';
import type { ResearchIndex } from '@sdlc-on-fire/core/browser';

/**
 * The research panel (P6-SURFACE-04, FEAT-UI-006).
 *
 * Research was a first-class output that behaved like a scratch file: notes
 * existed, nothing grouped them, and nothing said whether anybody had asked for
 * them. So this leads with the two counts that say whether the habit is
 * working — how much research is linked to no work item, and how much cites no
 * source — rather than opening on a tidy list that looks the same either way.
 */

export interface ResearchPanelProps {
  readonly index: ResearchIndex | undefined;
  readonly loading?: boolean;
}

export function ResearchPanel({ index, loading = false }: ResearchPanelProps): ReactElement {
  if (loading) return <p className="research__empty">loading…</p>;
  if (index === undefined || index.total === 0) {
    return <p className="research__empty">no research recorded yet</p>;
  }

  return (
    <section className="research" aria-label="Research">
      <p className="research__summary">{index.because}</p>

      {index.unlinked.length > 0 ? (
        <p className="research__warning">
          {index.unlinked.length} note(s) linked to no work item — research nobody asked for.
        </p>
      ) : null}
      {index.uncited.length > 0 ? (
        <p className="research__note">{index.uncited.length} note(s) cite no source.</p>
      ) : null}

      {index.byTopic.map((group) => (
        <article key={group.topic} className="research__topic">
          <h3>{group.topic}</h3>
          <ul>
            {group.entries.map((entry) => (
              <li key={entry.id} className="research__entry">
                <span className="research__title">{entry.title}</span>
                <code className="research__path">{entry.filePath}</code>
                {entry.relatedWorkItems.length === 0 ? (
                  <span className="research__unlinked">not linked to a work item</span>
                ) : (
                  <span className="research__links">{entry.relatedWorkItems.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

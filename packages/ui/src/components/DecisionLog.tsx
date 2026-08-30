import type { ReactElement } from 'react';
import type { DecisionLog as DecisionLogData } from '@sdlc-on-fire/core/browser';

/**
 * The decision log (P6-SURFACE-04, FEAT-UI-007).
 *
 * Decisions are the institutional memory of *why*, and the part that rots is
 * the supersession chain: an ADR marked `superseded` with no pointer, or a
 * pointer to an ADR that is not there, leaves a reader at a dead end while
 * every individual document still looks fine.
 *
 * So chain problems are rendered **first and prominently**. A decision log that
 * showed a broken chain as a clean list would be worse than none — it would
 * make somebody confident about a "why" that no longer resolves.
 */

export interface DecisionLogProps {
  readonly log: DecisionLogData | undefined;
  readonly loading?: boolean;
}

export function DecisionLog({ log, loading = false }: DecisionLogProps): ReactElement {
  if (loading) return <p className="decisions__empty">loading…</p>;
  if (log === undefined || log.entries.length === 0) {
    return <p className="decisions__empty">no decisions recorded yet</p>;
  }

  const byAdr = new Map(log.entries.map((entry) => [entry.adrId, entry]));

  return (
    <section className="decisions" aria-label="Decision log">
      <p className="decisions__summary">{log.because}</p>

      {log.unidentified.length > 0 ? (
        <p className="decisions__note">
          {log.unidentified.length} record(s) in the decisions directory declare no{' '}
          <code>adr_id</code> — usually an index, shown by path rather than dropped.
        </p>
      ) : null}

      {log.issues.length > 0 ? (
        <ul className="decisions__issues">
          {log.issues.map((issue) => (
            <li key={`${issue.adrId}-${issue.problem}`} className="decisions__issue">
              <strong>{issue.adrId}</strong> {issue.problem}: {issue.because}
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="decisions__chains">
        {log.chains.map((chain) => (
          <li key={chain.join('>')} className="decisions__chain">
            {chain.map((adrId, index) => {
              const entry = byAdr.get(adrId);
              return (
                <span key={adrId} className="decisions__link">
                  {index > 0 ? <span className="decisions__arrow"> → </span> : null}
                  <span
                    className={`decisions__adr decisions__adr--${entry?.status ?? 'unknown'}${
                      entry?.identified === false ? ' decisions__adr--unidentified' : ''
                    }`}
                  >
                    {adrId}
                  </span>{' '}
                  {/* A record with no `adr_id` is shown by path, and its title
                      falls back to that same path — printing both renders it
                      twice. One is enough to find the file. */}
                  {entry === undefined ? (
                    <span className="decisions__title">(not in the log)</span>
                  ) : entry.identified ? (
                    <span className="decisions__title">{entry.title}</span>
                  ) : null}
                </span>
              );
            })}
          </li>
        ))}
      </ol>
    </section>
  );
}

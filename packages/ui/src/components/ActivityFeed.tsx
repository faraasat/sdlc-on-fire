/**
 * The activity feed (P4-COLLAB-01).
 *
 * A board shows state; this shows what happened. The difference matters most
 * for the things that leave no trace on a card face — a comment that blocked a
 * gate, a run that failed and was retried, a card that went backwards. All of
 * those are invisible in a column position, and all of them are why somebody
 * opens a board asking "what changed".
 *
 * **Severity is carried, not decided here.** `role_effect` was resolved from
 * (type × role) at insert (ADR-0012), the daemon maps it to a severity, and
 * this renders that. A component that looked at the comment *type* and coloured
 * accordingly would be a second implementation of the one value the comment
 * model exists to make unambiguous — and would call a `normal`-typed comment
 * quiet while the stored effect said GATE_BLOCK.
 *
 * **Colour is never the only signal.** A blocking entry is marked with a token
 * colour *and* a word, because a red dot alone fails anyone who cannot
 * distinguish it — the same reason the risk chips carry text.
 */

import type { ReactElement } from 'react';
import type { ActivityEntry, ActivitySeverity } from '@sdlc-on-fire/core/browser';

/** The word shown beside a severity. Empty for the ordinary case, which needs none. */
const SEVERITY_LABEL: Record<ActivitySeverity, string> = {
  blocking: 'blocking',
  attention: 'needs attention',
  normal: '',
  quiet: '',
};

const KIND_LABEL: Record<ActivityEntry['kind'], string> = {
  transition: 'moved',
  comment: 'comment',
  gate: 'gate',
  run: 'run',
  claim: 'claim',
};

/**
 * A timestamp a person can read at a glance.
 *
 * Relative, and deliberately coarse. "3h ago" is what a reader of a feed
 * actually wants; a precise clock time makes them do arithmetic, and a
 * second-resolution relative time changes on every render for no benefit.
 */
export function ago(at: string, nowMs: number): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  // A skewed clock gives a negative age, and it needs no clamp: anything under
  // a minute — including a negative — already reads as "just now", which is the
  // honest rendering of "the two clocks disagree by a little". A `Math.max(0)`
  // here looked like it was handling that and changed no output at all.
  const seconds = Math.floor((nowMs - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

export function ActivityFeed({
  entries,
  nowMs = Date.now(),
  showCard = false,
}: {
  readonly entries: readonly ActivityEntry[];
  /** Injected so the rendering is testable without freezing the clock globally. */
  readonly nowMs?: number;
  /** Show which card each entry belongs to — for the board-wide feed. */
  readonly showCard?: boolean;
}): ReactElement {
  if (entries.length === 0) {
    return <p className="muted">Nothing has happened here yet.</p>;
  }

  return (
    <ol className="feed" aria-label="activity">
      {entries.map((entry, index) => (
        <li
          // Index is part of the key on purpose: two events can share a
          // timestamp, a card and a kind. React does not drop a duplicate-keyed
          // sibling on first render — it warns, and then reconciles the list
          // wrongly on the next update, which is the harder bug to see. The
          // test asserts the absence of that warning rather than a rendered
          // count, because the count looks correct either way.
          key={`${entry.at}-${entry.cardId}-${entry.kind}-${String(index)}`}
          className={`feed__row feed__row--${entry.severity}`}
        >
          <span className="feed__kind">{KIND_LABEL[entry.kind]}</span>
          {showCard ? <span className="feed__card">{entry.cardId}</span> : null}
          <span className="feed__summary">{entry.summary}</span>
          {entry.actor === null ? null : (
            <span className="feed__actor">
              {entry.actor}
              {entry.actorKind === 'agent' ? (
                // Marked, not merely named. An agent is an actor and never an
                // approver (ADR-0016), and a reader must be able to tell at a
                // glance which of the two wrote a line.
                <span className="feed__agent" title="agent, not a person">
                  {' '}
                  agent
                </span>
              ) : null}
            </span>
          )}
          {SEVERITY_LABEL[entry.severity] === '' ? null : (
            <span className="feed__severity">{SEVERITY_LABEL[entry.severity]}</span>
          )}
          <time className="feed__when" dateTime={entry.at}>
            {ago(entry.at, nowMs)}
          </time>
        </li>
      ))}
    </ol>
  );
}

/**
 * Who else is here (P4-COLLAB-01).
 *
 * The daemon has broadcast presence since P3-RT-02 and nothing rendered it, so
 * the feature existed and could not be reached — the state a board is in when
 * the tests are green and the person still cannot see the answer.
 *
 * Deliberately small. Presence is ambient information: useful at a glance,
 * never worth taking space from the board. It shows people, not tabs — the
 * collapse happens in `viewers()` upstream — and it shows nothing at all when
 * nobody else is connected, because "0 others" is noise where an empty space
 * is not.
 */

import type { ReactElement } from 'react';
import type { Viewer } from '@sdlc-on-fire/core/browser';

/**
 * Initials for an avatar, from a display name.
 *
 * Two letters at most, from the first and last word. A single word gives one
 * letter rather than its first two, which would turn "implementer" into "IM"
 * and read as a two-word name.
 */
export function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Everyone except yourself. Your own avatar tells you nothing you did not know. */
export function others(viewers: readonly Viewer[], selfActorId: string | null): readonly Viewer[] {
  if (selfActorId === null) return viewers;
  return viewers.filter((viewer) => viewer.actorId !== selfActorId);
}

export function PresenceBar({
  viewers,
  selfActorId = null,
  max = 5,
}: {
  readonly viewers: readonly Viewer[];
  readonly selfActorId?: string | null;
  readonly max?: number;
}): ReactElement | null {
  const here = others(viewers, selfActorId);
  if (here.length === 0) return null;

  const shown = here.slice(0, max);
  const overflow = here.length - shown.length;

  return (
    <div className="presence" aria-label={`${String(here.length)} other people on this board`}>
      {shown.map((viewer) => (
        <span
          key={viewer.key}
          className="presence__dot"
          // Title and aria-label both: the tooltip is for a mouse, the label is
          // for a screen reader, and initials alone are not a name to either.
          title={
            viewer.cardIds.length === 0
              ? viewer.displayName
              : `${viewer.displayName} — ${viewer.cardIds.join(', ')}`
          }
          aria-label={viewer.displayName}
        >
          {initials(viewer.displayName)}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="presence__more" aria-label={`${String(overflow)} more`}>
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

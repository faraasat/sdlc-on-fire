import type { ReactElement } from 'react';
import type { ResolvedIdentity } from '@sdlc-on-fire/core/browser';

/**
 * Who the board thinks you are, and how sure it is (P3-UI-01).
 *
 * The ground is shown, not hidden behind a name. An actor decides what you may
 * approve, and solo mode is an inference about an empty room rather than a fact
 * about a person — so a session that cannot attribute an action says so before
 * you reach for a button that needs it, rather than after.
 */
export function IdentityBadge({
  identity,
}: {
  identity: ResolvedIdentity | undefined;
}): ReactElement {
  if (identity === undefined) return <span className="identity identity--loading">…</span>;

  if (identity.actor === null) {
    return (
      <span className="identity identity--none" title={identity.because}>
        not identified
      </span>
    );
  }

  return (
    <span
      className={`identity identity--${identity.attributable ? 'strong' : 'weak'}`}
      title={identity.because}
    >
      {identity.actor.displayName}
      {identity.attributable ? null : <em> · solo mode, cannot approve</em>}
    </span>
  );
}

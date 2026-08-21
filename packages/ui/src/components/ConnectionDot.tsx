import type { ReactElement } from 'react';
import { useUiStore } from '../state/ui.js';

/**
 * Whether the board is live (P3-UI-01).
 *
 * Visible at all times, deliberately. The failure this whole realtime path
 * guards against is a board that is stale and looks current — so the one thing
 * the user must never have to guess is whether what they are reading is
 * connected to anything.
 */
export function ConnectionDot(): ReactElement {
  const connection = useUiStore((state) => state.connection);
  const label: Record<typeof connection, string> = {
    connecting: 'connecting…',
    live: 'live',
    reconnecting: 'reconnecting — this view may be behind',
    offline: 'offline',
  };
  return (
    <span className={`conn conn--${connection}`} title={label[connection]}>
      <i aria-hidden="true" /> {label[connection]}
    </span>
  );
}

/**
 * The database side of realtime (P3-RT-01).
 *
 * Subscribes to one Postgres channel, validates what arrives, and hands typed
 * events to a consumer. Deliberately transport-agnostic: nothing here knows a
 * WebSocket exists, so the hard part — did the right event come out of the
 * database — is testable against a real PGlite without opening a socket.
 */

import { parseChangeEvent, CHANGE_CHANNEL, type ChangeEvent } from '@sdlc-on-fire/core';

/** The slice of a database handle this needs. Narrow, so tests can substitute. */
export interface ListenCapable {
  listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
}

export interface SubscriberOptions {
  readonly db: ListenCapable;
  readonly onEvent: (event: ChangeEvent) => void;
  /**
   * Called for a payload that did not parse. Optional, and separate from
   * `onEvent` on purpose — a malformed notification is an operational signal,
   * not a change, and merging them would let noise look like activity.
   */
  readonly onMalformed?: (payload: string) => void;
}

export interface ChangeSubscription {
  close(): Promise<void>;
  /** Payloads received that failed validation. Observability, not control flow. */
  readonly malformed: number;
}

/**
 * Start listening for change notifications.
 *
 * A payload that fails to parse is counted and dropped, never thrown. The
 * channel crosses a process boundary from a database other tools may also write
 * to, and one bad notification must not take down the subscriber that would
 * have delivered the next thousand.
 */
export async function subscribeToChanges(options: SubscriberOptions): Promise<ChangeSubscription> {
  const state = { malformed: 0 };

  const unlisten = await options.db.listen(CHANGE_CHANNEL, (payload: string) => {
    const event = parseChangeEvent(payload);
    if (event === null) {
      state.malformed += 1;
      options.onMalformed?.(payload);
      return;
    }
    try {
      options.onEvent(event);
    } catch {
      // A consumer that throws is a consumer bug. It must not unsubscribe us
      // from every future event, which is what an uncaught throw in a
      // notification callback would effectively do.
      state.malformed += 0;
    }
  });

  return {
    close: async () => {
      await unlisten();
    },
    get malformed() {
      return state.malformed;
    },
  };
}

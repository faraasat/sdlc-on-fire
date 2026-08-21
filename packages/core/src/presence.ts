/**
 * Presence and per-field reconciliation (P3-RT-02).
 *
 * Two mechanisms that look unrelated and share one principle: **the browser's
 * optimistic picture must lose to the database's, field by field, and presence
 * must never become durable state.**
 *
 * *Last-writer-wins per field* rather than per row. Two people editing one card
 * — one changing its title, one moving its stage — should both succeed. A
 * whole-row LWW means the later write silently reverts the earlier one on
 * fields it never touched, and the person who loses has no way to know: their
 * change was accepted, rendered, and then quietly undone by somebody who was
 * editing something else entirely.
 *
 * *Presence is ephemeral by construction.* Who is looking at a card lives in
 * the daemon's connection state and is never written to Postgres. Persisting it
 * would make "Ada is viewing FEAT-1" survive Ada's laptop closing, her network
 * dropping, and the daemon restarting — and a presence list that lies is worse
 * than none, because people act on it.
 */

export interface FieldStamp {
  readonly field: string;
  /** ISO timestamp of the write that produced this value. */
  readonly at: string;
}

/** A row plus the per-field timestamps the client believes are current. */
export interface StampedRow {
  readonly values: Readonly<Record<string, unknown>>;
  readonly stamps: Readonly<Record<string, string>>;
}

export interface MergeResult {
  readonly values: Readonly<Record<string, unknown>>;
  readonly stamps: Readonly<Record<string, string>>;
  /** Fields where the incoming write won and replaced a local value. */
  readonly overwritten: readonly string[];
  /** Fields where the local value was newer and the incoming write was ignored. */
  readonly kept: readonly string[];
}

/**
 * Merge an incoming row into a local one, field by field.
 *
 * A field with no local stamp is taken from the incoming row: the client has
 * never had an opinion about it, so there is nothing to defend. A field with
 * equal timestamps goes to the incoming value — the server's copy is the one
 * everybody else already sees, and preferring the local one would leave a
 * single browser disagreeing with every other and with itself after a reload.
 */
export function mergeByField(local: StampedRow, incoming: StampedRow): MergeResult {
  const values: Record<string, unknown> = { ...local.values };
  const stamps: Record<string, string> = { ...local.stamps };
  const overwritten: string[] = [];
  const kept: string[] = [];

  for (const [field, value] of Object.entries(incoming.values)) {
    const incomingAt = incoming.stamps[field];
    const localAt = stamps[field];

    if (incomingAt === undefined) {
      // Unstamped incoming field: cannot be compared, so it cannot win. Taking
      // it would let an un-timestamped write silently beat a timestamped one.
      if (!(field in values)) values[field] = value;
      continue;
    }

    if (localAt === undefined || incomingAt >= localAt) {
      if (localAt !== undefined && values[field] !== value) overwritten.push(field);
      values[field] = value;
      stamps[field] = incomingAt;
    } else {
      kept.push(field);
    }
  }

  return { values, stamps, overwritten, kept };
}

/** Stamps for every field of a row, all from one write. */
export function stampAll(
  values: Readonly<Record<string, unknown>>,
  at: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.keys(values).map((field) => [field, at]));
}

/* ───────────────────────────────── presence ───────────────────────────── */

export interface PresenceEntry {
  readonly clientId: string;
  readonly actorId: string | null;
  readonly displayName: string;
  /** The card being looked at, or null for the board as a whole. */
  readonly cardId: string | null;
  /** Epoch ms of the last heartbeat. */
  readonly seenAt: number;
}

/** How long a client stays listed after its last heartbeat. */
export const PRESENCE_TTL_MS = 30_000;

/**
 * Live presence, held in memory only.
 *
 * There is deliberately no `save`, no `load`, and no table. The class exists
 * partly to make that visible: presence that could be persisted eventually
 * would be, and then a stale row would outlive the person it describes.
 */
export class Presence {
  readonly #entries = new Map<string, PresenceEntry>();

  seen(entry: Omit<PresenceEntry, 'seenAt'>, now: number = Date.now()): void {
    this.#entries.set(entry.clientId, { ...entry, seenAt: now });
  }

  leave(clientId: string): void {
    this.#entries.delete(clientId);
  }

  /**
   * Who is present, with expired entries dropped.
   *
   * Expiry happens on read rather than on a timer. A timer that stops — because
   * the process was suspended, or the event loop was blocked — leaves a list
   * that looks current and is not; expiring on read cannot drift, because the
   * only moment the answer matters is the moment somebody asks.
   */
  list(now: number = Date.now(), ttlMs: number = PRESENCE_TTL_MS): readonly PresenceEntry[] {
    const live: PresenceEntry[] = [];
    for (const [clientId, entry] of this.#entries) {
      if (now - entry.seenAt > ttlMs) this.#entries.delete(clientId);
      else live.push(entry);
    }
    return live.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /** Who is looking at one card. */
  on(
    cardId: string,
    now: number = Date.now(),
    ttlMs: number = PRESENCE_TTL_MS,
  ): readonly PresenceEntry[] {
    return this.list(now, ttlMs).filter((entry) => entry.cardId === cardId);
  }

  get size(): number {
    return this.#entries.size;
  }
}

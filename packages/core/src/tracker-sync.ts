/**
 * Provider-agnostic two-way sync primitives (P5-TRACK-01).
 *
 * GitHub is the first consumer; Linear and Jira are specified to reuse these
 * (phase 5, TRACK-02/03), so nothing here may know what a GitHub issue is.
 *
 * The whole problem this file exists for is that **a two-way sync is a
 * distributed write with no lock**, and every cheap version of it loses data.
 * Three rules follow, and they are the design:
 *
 * 1. **Both sides changed is a conflict, not a merge.** There is no correct
 *    automatic answer to "the title changed here and the body changed there,"
 *    only a convenient one. `decide` refuses; a policy may override, but the
 *    override is named at the call site and recorded, never a default. This is
 *    ADR-0040's shape: the sync proposes, a deterministic rule disposes, and
 *    where no rule can dispose honestly it stops.
 *
 * 2. **Never compare our clock to theirs.** Timestamps here are only ever
 *    compared provider-to-provider — the `updatedAt` we stored from the remote
 *    against the `updatedAt` the remote reports now. Comparing a remote
 *    timestamp to `Date.now()` reads clock skew as an edit, and the failure is
 *    silent: it syncs things that did not change and, when skew runs the other
 *    way, skips things that did.
 *
 * 3. **A first link is a conflict too.** Finding a local item and a remote item
 *    that have never been synced does not tell you which is right. Adopting one
 *    silently overwrites the other, so an unlinked pair is only auto-adopted
 *    when the two already agree.
 */

/** What the remote holds, reduced to the fields a sync can act on. */
export interface RemoteItem {
  /** The provider's own id — GitHub's issue number, Linear's identifier. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly closed: boolean;
  /** The provider's timestamp, verbatim. Never our clock. */
  readonly updatedAt: string;
  /**
   * True when this is not really a work item.
   *
   * GitHub's REST API considers every pull request an issue and returns them
   * from the issues list; the `pull_request` key is the only thing separating
   * them. A sync that does not filter here pulls every PR onto the board as a
   * story — which is why this is a field on the shared shape rather than a
   * detail inside the GitHub adapter.
   */
  readonly foreign: boolean;
}

/** What we hold locally, reduced the same way. */
export interface LocalItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly closed: boolean;
}

/**
 * What the last successful sync saw, per linked pair.
 *
 * `localFingerprint` is canonical JSON rather than a hash. A hash would make
 * the cursor smaller and introduce a collision class whose symptom is a *missed
 * update* — a silent data loss that looks exactly like "nothing changed".
 * Cursors are small; the trade is not worth taking.
 */
export interface SyncCursor {
  readonly key: string;
  readonly remoteId: string;
  readonly localFingerprint: string;
  readonly remoteUpdatedAt: string;
}

export type SyncAction =
  'none' | 'skip-foreign' | 'create-remote' | 'create-local' | 'push' | 'pull' | 'conflict';

export interface SyncDecision {
  readonly action: SyncAction;
  /** Why, in words a person reading a dry-run can act on. */
  readonly because: string;
  /** Set only for `conflict` — which sides moved. */
  readonly diverged?: { readonly local: boolean; readonly remote: boolean } | undefined;
}

/**
 * The canonical form used for local change detection.
 *
 * Field order is fixed here rather than taken from object key order, because
 * key order is an accident of construction: the same item built two ways would
 * otherwise fingerprint differently and resync forever.
 */
export function fingerprint(local: LocalItem): string {
  return JSON.stringify([local.title, local.body, local.closed]);
}

export type ConflictPolicy = 'refuse' | 'prefer-local' | 'prefer-remote';

export interface DecideInput {
  readonly local?: LocalItem | undefined;
  readonly remote?: RemoteItem | undefined;
  readonly cursor?: SyncCursor | undefined;
  /** Defaults to `refuse`. Anything else must be asked for by name. */
  readonly policy?: ConflictPolicy | undefined;
}

export function decide(input: DecideInput): SyncDecision {
  const { local, remote, cursor } = input;
  const policy: ConflictPolicy = input.policy ?? 'refuse';

  if (remote?.foreign === true) {
    return { action: 'skip-foreign', because: 'the remote item is not a work item (pull request)' };
  }

  if (local === undefined && remote === undefined) {
    return { action: 'none', because: 'neither side has this item' };
  }

  // One side is gone. Deletion is deliberately not inferred: a missing item may
  // have been deleted, or may simply be outside the window the caller listed.
  // Treating absence as intent to delete makes a narrow query destructive.
  if (local === undefined) {
    return cursor === undefined
      ? { action: 'create-local', because: 'the remote has an item we have never seen' }
      : {
          action: 'none',
          because: 'the local item is absent from this batch; absence is not deletion',
        };
  }
  if (remote === undefined) {
    return cursor === undefined
      ? { action: 'create-remote', because: 'the local item has never been pushed' }
      : {
          action: 'none',
          because: 'the remote item is absent from this batch; absence is not deletion',
        };
  }

  const localMoved = cursor === undefined || fingerprint(local) !== cursor.localFingerprint;
  const remoteMoved = cursor === undefined || remote.updatedAt !== cursor.remoteUpdatedAt;

  if (cursor === undefined) {
    // First link. Auto-adopt only when the two already agree — otherwise
    // picking a side silently discards whichever one we did not pick.
    return agree(local, remote)
      ? { action: 'none', because: 'first link, and both sides already match' }
      : {
          action: 'conflict',
          because:
            'first link between two items that already differ; nothing records which is authoritative',
          diverged: { local: true, remote: true },
        };
  }

  if (!localMoved && !remoteMoved) return { action: 'none', because: 'neither side changed' };
  if (localMoved && !remoteMoved) return { action: 'push', because: 'only the local item changed' };
  if (!localMoved && remoteMoved)
    return { action: 'pull', because: 'only the remote item changed' };

  const diverged = { local: true, remote: true };
  if (policy === 'prefer-local') {
    return {
      action: 'push',
      because: 'both sides changed; policy prefer-local resolved it',
      diverged,
    };
  }
  if (policy === 'prefer-remote') {
    return {
      action: 'pull',
      because: 'both sides changed; policy prefer-remote resolved it',
      diverged,
    };
  }
  return {
    action: 'conflict',
    because: 'both sides changed since the last sync; there is no correct automatic answer',
    diverged,
  };
}

function agree(local: LocalItem, remote: RemoteItem): boolean {
  return (
    local.title === remote.title && local.body === remote.body && local.closed === remote.closed
  );
}

/**
 * The cursor to store after a decision was carried out.
 *
 * Takes the remote's *post-write* `updatedAt` rather than the one we read
 * before writing. A push changes `updatedAt` on the remote; storing the
 * pre-write value makes our own write look like somebody else's edit on the
 * very next pass, and every subsequent sync reports a conflict that is really
 * just our last one.
 */
export function advanceCursor(input: {
  key: string;
  local: LocalItem;
  remote: RemoteItem;
}): SyncCursor {
  return {
    key: input.key,
    remoteId: input.remote.id,
    localFingerprint: fingerprint(input.local),
    remoteUpdatedAt: input.remote.updatedAt,
  };
}

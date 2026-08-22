/**
 * The two-way sync run (P5-TRACK-01).
 *
 * `decide` answers "what should happen to this one item". This answers "what
 * happens to a batch, in what order, and what does a person see afterwards" —
 * and those are where a sync stops being a pure function and starts being an
 * operation that can half-succeed.
 *
 * Four things it will not do:
 *
 *   * **It will not stop the batch on a conflict.** One item nobody can
 *     auto-resolve is not a reason to leave the other ninety-nine unsynced.
 *     Conflicts are collected and reported, never thrown.
 *
 *   * **It will not report success when it found conflicts.** `ok` is false
 *     whenever anything was left unresolved, so a caller wiring this into CI
 *     gets a non-zero exit rather than a green run over a drifting board. A
 *     sync that reports success while silently diverging is worse than no sync,
 *     because it also removes the suspicion that would have caught it.
 *
 *   * **It will not run mutations concurrently.** GitHub asks for serial
 *     mutative requests with a gap; a parallel `Promise.all` here earns a
 *     secondary rate limit and, if it keeps going, a ban. Reads may be
 *     concurrent, writes are a queue.
 *
 *   * **It will not advance a cursor for work it did not do.** A dry run
 *     returns the decisions and touches nothing, because a dry run that moves
 *     the cursor makes the real run a no-op — the failure mode where the
 *     rehearsal consumes the performance.
 */

import {
  advanceCursor,
  decide,
  type ConflictPolicy,
  type LocalItem,
  type RemoteItem,
  type SyncCursor,
  type SyncDecision,
} from './tracker-sync.js';

/** What the engine needs from a provider. Implemented per tracker. */
export interface SyncPort {
  /** Every item changed since the given timestamp, pagination already handled. */
  list(since?: string): Promise<readonly RemoteItem[]>;
  create(local: LocalItem): Promise<RemoteItem>;
  update(remoteId: string, local: LocalItem): Promise<RemoteItem>;
  /** Materialise a remote item locally. Returns the local id it was given. */
  adopt(remote: RemoteItem): Promise<LocalItem>;
}

export interface SyncOutcome {
  readonly key: string;
  readonly decision: SyncDecision;
  /** Absent on a dry run, or when the decision was `none`/`skip-foreign`. */
  readonly cursor?: SyncCursor | undefined;
  /** Set when the provider call threw. The item is skipped, the run continues. */
  readonly failure?: string | undefined;
}

export interface SyncReport {
  /** False if anything conflicted or failed. Drives the CLI exit code. */
  readonly ok: boolean;
  readonly outcomes: readonly SyncOutcome[];
  readonly conflicts: readonly SyncOutcome[];
  readonly failures: readonly SyncOutcome[];
  readonly applied: number;
  readonly dryRun: boolean;
}

export interface SyncRunInput {
  readonly locals: readonly LocalItem[];
  readonly port: SyncPort;
  /** Cursors from the last run, keyed by `externalRefKey`. */
  readonly cursors: ReadonlyMap<string, SyncCursor>;
  /** Builds the idempotency key for a pair. Injected so core stays provider-agnostic. */
  readonly keyFor: (args: {
    local?: LocalItem | undefined;
    remote?: RemoteItem | undefined;
  }) => string;
  readonly since?: string | undefined;
  readonly policy?: ConflictPolicy | undefined;
  readonly dryRun?: boolean | undefined;
  /** Milliseconds between mutative calls. Injected so tests are not slow. */
  readonly gapMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runSync(input: SyncRunInput): Promise<SyncReport> {
  const dryRun = input.dryRun ?? false;
  const gapMs = input.gapMs ?? 1_000;
  const sleep = input.sleep ?? defaultSleep;

  const remotes = await input.port.list(input.since);

  // Pair both sides up by key before deciding anything. Iterating locals and
  // looking up remotes would silently drop every remote-only item — the whole
  // inbound half of a two-way sync — and the run would still look successful.
  const pairs = new Map<string, { local?: LocalItem; remote?: RemoteItem }>();
  for (const local of input.locals) {
    const key = input.keyFor({ local });
    pairs.set(key, { ...pairs.get(key), local });
  }
  for (const remote of remotes) {
    const key = input.keyFor({ remote });
    pairs.set(key, { ...pairs.get(key), remote });
  }

  const outcomes: SyncOutcome[] = [];
  let mutated = false;

  for (const [key, pair] of pairs) {
    const cursor = input.cursors.get(key);
    const decision = decide({
      local: pair.local,
      remote: pair.remote,
      cursor,
      policy: input.policy,
    });

    if (decision.action === 'none' || decision.action === 'skip-foreign') {
      outcomes.push({ key, decision });
      continue;
    }
    if (decision.action === 'conflict' || dryRun) {
      outcomes.push({ key, decision });
      continue;
    }

    // Serial, with a gap before every mutation after the first.
    if (mutated && gapMs > 0) await sleep(gapMs);
    mutated = true;

    try {
      const next = await applyDecision(input.port, decision.action, pair, key);
      outcomes.push({ key, decision, cursor: next });
    } catch (error) {
      // One provider failure does not end the run — but it does mean `ok` is
      // false, so the caller cannot mistake a partial sync for a complete one.
      outcomes.push({
        key,
        decision,
        failure: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const conflicts = outcomes.filter((o) => o.decision.action === 'conflict');
  const failures = outcomes.filter((o) => o.failure !== undefined);
  return {
    ok: conflicts.length === 0 && failures.length === 0,
    outcomes,
    conflicts,
    failures,
    applied: outcomes.filter((o) => o.cursor !== undefined).length,
    dryRun,
  };
}

async function applyDecision(
  port: SyncPort,
  action: SyncDecision['action'],
  pair: { local?: LocalItem | undefined; remote?: RemoteItem | undefined },
  key: string,
): Promise<SyncCursor> {
  if (action === 'create-remote') {
    const local = required(pair.local, 'create-remote without a local item');
    return advanceCursor({ key, local, remote: await port.create(local) });
  }
  if (action === 'create-local') {
    const remote = required(pair.remote, 'create-local without a remote item');
    return advanceCursor({ key, local: await port.adopt(remote), remote });
  }
  if (action === 'push') {
    const local = required(pair.local, 'push without a local item');
    const remote = required(pair.remote, 'push without a remote item');
    // The cursor takes the *post-write* remote, so our own edit is not read as
    // somebody else's on the next pass.
    return advanceCursor({ key, local, remote: await port.update(remote.id, local) });
  }
  if (action === 'pull') {
    const remote = required(pair.remote, 'pull without a remote item');
    return advanceCursor({ key, local: await port.adopt(remote), remote });
  }
  throw new Error(`unreachable sync action: ${action}`);
}

function required<T>(value: T | undefined, because: string): T {
  if (value === undefined) throw new Error(because);
  return value;
}

/** A conflict rendered for a person, not for a log parser. */
export function describeConflicts(report: SyncReport): string {
  if (report.conflicts.length === 0) return 'no conflicts';
  const lines = report.conflicts.map((c) => `  ${c.key} — ${c.decision.because}`);
  return [
    `${String(report.conflicts.length)} item(s) changed on both sides and were left alone:`,
    ...lines,
    '',
    'Nothing was overwritten. Resolve each one, or re-run with an explicit',
    '--policy to say which side wins.',
  ].join('\n');
}

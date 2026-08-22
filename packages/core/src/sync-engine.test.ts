import { describe, expect, it, vi } from 'vitest';
import { describeConflicts, runSync, type SyncPort } from './sync-engine.js';
import { fingerprint, type LocalItem, type RemoteItem, type SyncCursor } from './tracker-sync.js';

const local = (over: Partial<LocalItem> = {}): LocalItem => ({
  id: 'STORY-1',
  title: 'a title',
  body: 'a body',
  closed: false,
  ...over,
});

const remote = (over: Partial<RemoteItem> = {}): RemoteItem => ({
  id: '42',
  title: 'a title',
  body: 'a body',
  closed: false,
  updatedAt: '2026-08-23T10:00:00Z',
  foreign: false,
  ...over,
});

/**
 * Stands in for `external_ref` keying: a linked local item keys on the remote
 * id it is bound to, an unlinked one on its own id, and a remote always on its
 * own id. That is what makes a linked pair land on the same key — the thing the
 * real `externalRefKey` does from frontmatter.
 */
const keyForWith =
  (links: Record<string, string>) =>
  ({
    local: l,
    remote: r,
  }: {
    local?: LocalItem | undefined;
    remote?: RemoteItem | undefined;
  }): string =>
    l !== undefined ? `k:${links[l.id] ?? l.id}` : `k:${r?.id ?? '?'}`;
const keyFor = keyForWith({});

function fakePort(over: Partial<SyncPort> = {}): SyncPort & { calls: string[] } {
  const calls: string[] = [];
  const port = {
    calls,
    list: () => Promise.resolve([]),
    create: (l: LocalItem) => {
      calls.push(`create:${l.id}`);
      return Promise.resolve(
        remote({ id: 'new', title: l.title, updatedAt: '2026-08-23T12:00:00Z' }),
      );
    },
    update: (id: string, l: LocalItem) => {
      calls.push(`update:${id}`);
      return Promise.resolve(
        remote({ id, title: l.title, body: l.body, updatedAt: '2026-08-23T12:00:00Z' }),
      );
    },
    adopt: (r: RemoteItem) => {
      calls.push(`adopt:${r.id}`);
      return Promise.resolve(
        local({ id: `ADOPTED-${r.id}`, title: r.title, body: r.body, closed: r.closed }),
      );
    },
    ...over,
  };
  return port;
}

const noCursors = new Map<string, SyncCursor>();
const base = { keyFor, cursors: noCursors, gapMs: 0 };

describe('runSync — pairing', () => {
  it('creates remotely for a local-only item', async () => {
    const port = fakePort();
    const report = await runSync({ ...base, locals: [local()], port });
    expect(port.calls).toEqual(['create:STORY-1']);
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(1);
  });

  it('adopts a remote-only item instead of dropping it', async () => {
    // Iterating locals alone would silently discard the entire inbound half of
    // the sync while still reporting success.
    const port = fakePort({ list: () => Promise.resolve([remote({ id: '7', title: 'theirs' })]) });
    const report = await runSync({ ...base, locals: [], port });
    expect(port.calls).toEqual(['adopt:7']);
    expect(report.applied).toBe(1);
  });

  it('handles both halves in one run', async () => {
    const port = fakePort({ list: () => Promise.resolve([remote({ id: '7', title: 'theirs' })]) });
    await runSync({ ...base, locals: [local()], port });
    expect(port.calls.sort()).toEqual(['adopt:7', 'create:STORY-1']);
  });

  it('skips a pull request without calling the provider', async () => {
    const port = fakePort({
      list: () => Promise.resolve([remote({ id: '9', title: 'a PR', foreign: true })]),
    });
    const report = await runSync({ ...base, locals: [], port });
    expect(port.calls).toEqual([]);
    expect(report.outcomes[0]?.decision.action).toBe('skip-foreign');
    expect(report.ok).toBe(true);
  });
});

describe('runSync — conflicts', () => {
  const conflicting = () => {
    const cursors = new Map<string, SyncCursor>([
      [
        'k:42',
        {
          key: 'k:42',
          remoteId: '42',
          localFingerprint: fingerprint(local()),
          remoteUpdatedAt: '2026-08-23T10:00:00Z',
        },
      ],
    ]);
    const port = fakePort({
      list: () => Promise.resolve([remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' })]),
    });
    return {
      cursors,
      port,
      locals: [local({ title: 'ours' })],
      keyFor: keyForWith({ 'STORY-1': '42' }),
    };
  };

  it('reports a conflict and writes nothing', async () => {
    const { cursors, port, locals, keyFor: k } = conflicting();
    const report = await runSync({ ...base, cursors, locals, port, keyFor: k });
    expect(report.conflicts).toHaveLength(1);
    expect(port.calls).toEqual([]);
  });

  it('records a conflict as a conflict, never as a provider failure', async () => {
    // A conflict that reached the apply path would be caught by the failure
    // handler and reported as an error. `ok` would still be false, so the run
    // looks correct from the outside — but the operator is told the provider
    // broke when in fact their board diverged, which is a different problem
    // with a different fix.
    const { cursors, port, locals, keyFor: k } = conflicting();
    const report = await runSync({ ...base, cursors, locals, port, keyFor: k });
    expect(report.failures).toEqual([]);
    expect(report.outcomes.every((o) => o.failure === undefined)).toBe(true);
  });

  it('does not spend a rate-limit gap on an item it never writes', async () => {
    const sleep = (await import('vitest')).vi.fn(() => Promise.resolve());
    const { cursors, port, locals, keyFor: k } = conflicting();
    await runSync({ ...base, cursors, locals, port, keyFor: k, gapMs: 1_000, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is NOT ok when there are conflicts, so CI fails instead of passing over drift', async () => {
    const { cursors, port, locals, keyFor: k } = conflicting();
    expect((await runSync({ ...base, cursors, locals, port, keyFor: k })).ok).toBe(false);
  });

  it('does not let one conflict stop the rest of the batch', async () => {
    const { cursors, port, locals, keyFor: k } = conflicting();
    const clean = local({ id: 'STORY-2', title: 'clean' });
    const report = await runSync({ ...base, cursors, locals: [...locals, clean], port, keyFor: k });
    expect(port.calls).toEqual(['create:STORY-2']);
    expect(report.conflicts).toHaveLength(1);
    expect(report.applied).toBe(1);
  });

  it('resolves when a policy is named', async () => {
    const { cursors, port, locals, keyFor: k } = conflicting();
    const report = await runSync({
      ...base,
      cursors,
      locals,
      port,
      keyFor: k,
      policy: 'prefer-local',
    });
    expect(port.calls).toEqual(['update:42']);
    expect(report.ok).toBe(true);
  });
});

describe('runSync — dry run', () => {
  it('returns decisions without calling the provider', async () => {
    const port = fakePort({ list: () => Promise.resolve([remote({ id: '7', title: 'theirs' })]) });
    const report = await runSync({ ...base, locals: [local()], port, dryRun: true });
    expect(port.calls).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.outcomes.map((o) => o.decision.action).sort()).toEqual([
      'create-local',
      'create-remote',
    ]);
  });

  it('advances no cursor, so the real run is not turned into a no-op', async () => {
    const port = fakePort();
    const report = await runSync({ ...base, locals: [local()], port, dryRun: true });
    expect(report.applied).toBe(0);
    expect(report.outcomes.every((o) => o.cursor === undefined)).toBe(true);
  });

  it('still reports conflicts', async () => {
    const cursors = new Map<string, SyncCursor>([
      [
        'k:42',
        {
          key: 'k:42',
          remoteId: '42',
          localFingerprint: fingerprint(local()),
          remoteUpdatedAt: '2026-08-23T10:00:00Z',
        },
      ],
    ]);
    const port = fakePort({
      list: () => Promise.resolve([remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' })]),
    });
    const report = await runSync({
      ...base,
      cursors,
      locals: [local({ title: 'ours' })],
      port,
      keyFor: keyForWith({ 'STORY-1': '42' }),
      dryRun: true,
    });
    expect(report.conflicts).toHaveLength(1);
    expect(report.ok).toBe(false);
  });
});

describe('runSync — provider failures', () => {
  it('continues past a failed item and marks the run not ok', async () => {
    const port = fakePort({
      create: (l: LocalItem) =>
        l.id === 'STORY-1'
          ? Promise.reject(new Error('422 validation failed'))
          : Promise.resolve(remote({ id: 'new' })),
    });
    const report = await runSync({
      ...base,
      locals: [local(), local({ id: 'STORY-2' })],
      port,
    });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.failure).toContain('422');
    expect(report.applied).toBe(1);
    expect(report.ok).toBe(false);
  });

  it('does not advance a cursor for an item that failed', async () => {
    const port = fakePort({
      create: () => Promise.reject(new Error('nope')),
    });
    const report = await runSync({ ...base, locals: [local()], port });
    expect(report.outcomes[0]?.cursor).toBeUndefined();
  });
});

describe('runSync — rate-limit discipline', () => {
  it('leaves a gap between mutations but not before the first', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const port = fakePort();
    await runSync({
      ...base,
      gapMs: 1_000,
      sleep,
      locals: [local(), local({ id: 'STORY-2' }), local({ id: 'STORY-3' })],
      port,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it('does not sleep at all when nothing is mutated', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const port = fakePort({
      list: () => Promise.resolve([remote({ foreign: true, title: 'pr' })]),
    });
    await runSync({ ...base, gapMs: 1_000, sleep, locals: [], port });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('runs mutations serially rather than concurrently', async () => {
    const order: string[] = [];
    const port = fakePort({
      create: async (l: LocalItem) => {
        order.push(`start:${l.id}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${l.id}`);
        return remote({ id: l.id });
      },
    });
    await runSync({ ...base, locals: [local(), local({ id: 'STORY-2' })], port });
    expect(order).toEqual(['start:STORY-1', 'end:STORY-1', 'start:STORY-2', 'end:STORY-2']);
  });
});

describe('runSync — since', () => {
  it('passes the incremental cursor through to the provider', async () => {
    const list = vi.fn(() => Promise.resolve([]));
    const port = fakePort({ list });
    await runSync({ ...base, locals: [], port, since: '2026-08-01T00:00:00Z' });
    expect(list).toHaveBeenCalledWith('2026-08-01T00:00:00Z');
  });
});

describe('describeConflicts', () => {
  it('says nothing was overwritten, because that is the question a person has', async () => {
    const cursors = new Map<string, SyncCursor>([
      [
        'k:42',
        {
          key: 'k:42',
          remoteId: '42',
          localFingerprint: fingerprint(local()),
          remoteUpdatedAt: '2026-08-23T10:00:00Z',
        },
      ],
    ]);
    const port = fakePort({
      list: () => Promise.resolve([remote({ body: 'theirs', updatedAt: '2026-08-23T11:00:00Z' })]),
    });
    const report = await runSync({
      ...base,
      cursors,
      locals: [local({ title: 'ours' })],
      port,
      keyFor: keyForWith({ 'STORY-1': '42' }),
    });
    const text = describeConflicts(report);
    expect(text).toContain('Nothing was overwritten');
    expect(text).toContain('k:42');
  });

  it('is quiet when there is nothing to say', async () => {
    const report = await runSync({ ...base, locals: [], port: fakePort() });
    expect(describeConflicts(report)).toBe('no conflicts');
  });
});

describe('runSync — convergence', () => {
  /**
   * A stateful fake: `update` actually changes what the next `list` returns,
   * including the provider timestamp. Without that, a sync that never
   * converges looks identical to one that does.
   */
  function statefulPort(initial: RemoteItem) {
    let current = initial;
    let clock = 11;
    const calls: string[] = [];
    const port: SyncPort = {
      list: () => Promise.resolve([current]),
      create: (l: LocalItem) => {
        calls.push(`create:${l.id}`);
        clock += 1;
        current = { ...current, title: l.title, updatedAt: `2026-08-23T${String(clock)}:00:00Z` };
        return Promise.resolve(current);
      },
      update: (id: string, l: LocalItem) => {
        calls.push(`update:${id}`);
        clock += 1;
        current = {
          ...current,
          title: l.title,
          body: l.body,
          closed: l.closed,
          updatedAt: `2026-08-23T${String(clock)}:00:00Z`,
        };
        return Promise.resolve(current);
      },
      adopt: (r: RemoteItem) => {
        calls.push(`adopt:${r.id}`);
        return Promise.resolve(
          local({ id: `ADOPTED-${r.id}`, title: r.title, body: r.body, closed: r.closed }),
        );
      },
    };
    return { port, calls, now: () => current };
  }

  it('pushes once and then goes quiet, instead of resyncing forever', async () => {
    // The failure this guards is a cursor storing the *pre-write* remote
    // timestamp. Our own push then looks like a foreign edit on the next pass,
    // so every subsequent run reports a conflict that is really just our last
    // one — and the sync never settles.
    const { port, calls } = statefulPort(remote());
    const k = keyForWith({ 'STORY-1': '42' });
    const cursors = new Map<string, SyncCursor>([
      [
        'k:42',
        {
          key: 'k:42',
          remoteId: '42',
          localFingerprint: fingerprint(local()),
          remoteUpdatedAt: '2026-08-23T10:00:00Z',
        },
      ],
    ]);
    const locals = [local({ title: 'edited locally' })];

    const first = await runSync({ ...base, cursors, locals, port, keyFor: k });
    expect(calls).toEqual(['update:42']);
    expect(first.ok).toBe(true);

    // Carry the cursors forward exactly as a caller would.
    const next = new Map(cursors);
    for (const outcome of first.outcomes) {
      if (outcome.cursor !== undefined) next.set(outcome.key, outcome.cursor);
    }

    const second = await runSync({ ...base, cursors: next, locals, port, keyFor: k });
    expect(calls).toEqual(['update:42']);
    expect(second.ok).toBe(true);
    expect(second.applied).toBe(0);
    expect(second.conflicts).toEqual([]);
  });
});

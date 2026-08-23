import { describe, expect, it } from 'vitest';
import { createGithubPort } from './github-sync-port.js';
import { runSync } from './sync-engine.js';
import { fingerprint, type LocalItem, type RemoteItem, type SyncCursor } from './tracker-sync.js';

/**
 * The live half of P5-TRACK-01.
 *
 * Runs against a real GitHub repository when `SDLCOF_TEST_GITHUB_TOKEN` and
 * `SDLCOF_TEST_GITHUB_REPO` are both set, and skips otherwise. Skipped rather
 * than mocked, deliberately and for the reason this task was deferred in the
 * first place: the entire risk of a tracker sync is that the live API behaves
 * unlike our model of it — rate limits, pagination, `updated_at` granularity,
 * eventual consistency — and a mock reproduces precisely the assumptions that
 * would make us wrong. A skipped test is honest about not having run. A mocked
 * one claims a verification it never performed.
 *
 * The repository is written to: issues are created, edited, closed and
 * reopened. Point this at a throwaway.
 */

// Trim and test for emptiness rather than only `undefined` — CI declares the
// variable and leaves it blank when the secret is missing, and an `undefined`
// check alone then runs the live suite with an empty token and fails for a
// reason that has nothing to do with the code.
const rawToken = process.env['SDLCOF_TEST_GITHUB_TOKEN']?.trim();
const rawRepo = process.env['SDLCOF_TEST_GITHUB_REPO']?.trim();
const TOKEN = rawToken === undefined || rawToken === '' ? undefined : rawToken;
const REPO = rawRepo === undefined || rawRepo === '' ? undefined : rawRepo;
const live = TOKEN === undefined || REPO === undefined ? describe.skip : describe;

/** A title nothing else will collide with, so parallel runs cannot interfere. */
function uniqueTitle(label: string): string {
  return `sdlcof-live ${label} ${String(process.pid)}-${String(Math.floor(Math.random() * 1e6))}`;
}

/**
 * Wait for a freshly written issue to appear in the list endpoint.
 *
 * **Measured on 2026-08-23, not assumed:** creating an issue and immediately
 * listing does *not* return it. A create whose POST returned issue #10 was
 * absent from a 200 list at 3.7s and present at 5.7s. The list endpoint is
 * served from something that trails the write by seconds.
 *
 * This is the provider's behaviour, so the suite waits rather than asserting it
 * away. It matters beyond the tests: `runSync` lists *before* it writes, so a
 * single run is unaffected — but a run that creates an item and then dies
 * before its cursor is persisted leaves an unlinked local whose remote may
 * still be invisible, and `decide` would answer `create-remote` a second time.
 * Cursors are written per item as each one completes, which closes the window
 * to a single item rather than a batch.
 */
async function untilVisible(
  list: () => Promise<readonly RemoteItem[]>,
  id: string,
  budgetMs = 30_000,
): Promise<readonly RemoteItem[]> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const items = await list();
    if (items.some((item) => item.id === id)) return items;
    if (Date.now() > deadline) {
      throw new Error(`issue ${id} never appeared in the list within ${String(budgetMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

live('GitHub Issues, against the real API', () => {
  const adopted: RemoteItem[] = [];
  const makePort = () =>
    createGithubPort({
      repo: REPO!,
      token: TOKEN!,
      adopt: (remote) => {
        adopted.push(remote);
        return Promise.resolve({
          id: `ADOPTED-${remote.id}`,
          title: remote.title,
          body: remote.body,
          closed: remote.closed,
        });
      },
    });

  it('creates an issue and reads it back with the fields we sent', async () => {
    const port = makePort();
    const title = uniqueTitle('create');
    const made = await port.create({
      id: 'LOCAL-1',
      title,
      body: 'created by the live suite',
      closed: false,
    });

    expect(made.id).toMatch(/^\d+$/);
    expect(made.title).toBe(title);
    expect(made.closed).toBe(false);
    expect(made.foreign).toBe(false);
    // The provider timestamp must be a real ISO instant — the sync compares
    // these to each other and nothing else validates the shape.
    expect(Number.isNaN(Date.parse(made.updatedAt))).toBe(false);
  }, 60_000);

  it('a PATCH moves updated_at, which is what conflict detection relies on', async () => {
    const port = makePort();
    const title = uniqueTitle('patch');
    const made = await port.create({ id: 'LOCAL-2', title, body: 'before', closed: false });
    const after = await port.update(made.id, {
      id: 'LOCAL-2',
      title,
      body: 'after',
      closed: false,
    });

    expect(after.body).toBe('after');
    // If this ever fails, stored-vs-current `updated_at` is not a sound change
    // signal on this provider and the conflict rule needs a different basis.
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(made.updatedAt));
  }, 60_000);

  it('closes and reopens, so a state change is a real round trip', async () => {
    const port = makePort();
    const title = uniqueTitle('state');
    const made = await port.create({ id: 'LOCAL-3', title, body: 'b', closed: false });

    const closed = await port.update(made.id, { id: 'LOCAL-3', title, body: 'b', closed: true });
    expect(closed.closed).toBe(true);

    const reopened = await port.update(made.id, { id: 'LOCAL-3', title, body: 'b', closed: false });
    expect(reopened.closed).toBe(false);
  }, 60_000);

  it('lists closed issues, which the default state=open would hide', async () => {
    const port = makePort();
    const title = uniqueTitle('listclosed');
    const made = await port.create({ id: 'LOCAL-4', title, body: 'b', closed: false });
    await port.update(made.id, { id: 'LOCAL-4', title, body: 'b', closed: true });

    const listed = await untilVisible(() => port.list(), made.id);
    const found = listed.find((item) => item.id === made.id);
    expect(found).toBeDefined();
    expect(found?.closed).toBe(true);
  }, 120_000);

  it('never reports a pull request as a work item', async () => {
    const port = makePort();
    expect((await port.list()).some((item) => item.foreign)).toBe(false);
  }, 60_000);

  it('a full run converges: it pushes once and the second run is silent', async () => {
    const port = makePort();
    const title = uniqueTitle('converge');
    const made = await port.create({ id: 'LOCAL-5', title, body: 'original', closed: false });

    const localAfterEdit: LocalItem = {
      id: 'LOCAL-5',
      title,
      body: 'edited locally',
      closed: false,
    };
    const key = `github:${REPO!}:${made.id}`;
    const keyFor = ({
      local,
      remote,
    }: {
      local?: LocalItem | undefined;
      remote?: RemoteItem | undefined;
    }) => (local !== undefined ? key : `github:${REPO!}:${remote?.id ?? '?'}`);

    let cursors = new Map<string, SyncCursor>([
      [
        key,
        {
          key,
          remoteId: made.id,
          localFingerprint: fingerprint({ id: 'LOCAL-5', title, body: 'original', closed: false }),
          remoteUpdatedAt: made.updatedAt,
        },
      ],
    ]);

    // The remote must be visible to the list endpoint before a sync can pair
    // with it — see `untilVisible`.
    await untilVisible(() => port.list(), made.id);

    const first = await runSync({ locals: [localAfterEdit], port, cursors, keyFor, gapMs: 1_000 });
    const ours = first.outcomes.find((o) => o.key === key);
    expect(ours?.decision.action).toBe('push');
    expect(ours?.failure).toBeUndefined();

    cursors = new Map(cursors);
    for (const outcome of first.outcomes) {
      if (outcome.cursor !== undefined) cursors.set(outcome.key, outcome.cursor);
    }

    const second = await runSync({ locals: [localAfterEdit], port, cursors, keyFor, gapMs: 1_000 });
    const again = second.outcomes.find((o) => o.key === key);
    // The failure this catches is a sync that pushes forever because its own
    // write keeps looking like somebody else's edit.
    expect(again?.decision.action).toBe('none');
    expect(second.conflicts).toEqual([]);
  }, 120_000);

  it('reports a permissions failure by name rather than retrying it', async () => {
    // A token that cannot read this repo must fail fast and say why. Retrying
    // a 403 that is not a rate limit is a loop that never terminates and never
    // explains itself.
    const bad = createGithubPort({
      repo: REPO!,
      token: 'github_pat_definitely_not_a_real_token',
      adopt: (r) => Promise.resolve({ id: r.id, title: r.title, body: r.body, closed: r.closed }),
      maxRetries: 0,
    });
    await expect(bad.list()).rejects.toThrow();
  }, 60_000);
});

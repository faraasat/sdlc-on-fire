import { describe, expect, it, vi } from 'vitest';
import { createGithubPort, GithubApiError, type FetchLike } from './github-sync-port.js';
import type { LocalItem, RemoteItem } from './tracker-sync.js';

const issue = (over: Record<string, unknown> = {}) => ({
  number: 42,
  title: 'a title',
  body: 'a body',
  state: 'open',
  updated_at: '2026-08-23T10:00:00Z',
  ...over,
});

function reply(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

const adopt = (remote: RemoteItem): Promise<LocalItem> =>
  Promise.resolve({
    id: `ADOPTED-${remote.id}`,
    title: remote.title,
    body: remote.body,
    closed: remote.closed,
  });

function port(fetchImpl: FetchLike, over: Record<string, unknown> = {}) {
  return createGithubPort({
    repo: 'o/r',
    token: 'tok',
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    adopt,
    ...over,
  });
}

describe('list — pagination', () => {
  it('follows the Link header to the end rather than counting pages', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      if (urls.length === 1) {
        return Promise.resolve(
          reply([issue({ number: 1 })], {
            headers: { link: '<https://api.github.com/page2>; rel="next"' },
          }),
        );
      }
      return Promise.resolve(reply([issue({ number: 2 })]));
    });
    const items = await port(fetchImpl).list();
    expect(items.map((i) => i.id)).toEqual(['1', '2']);
    expect(urls[1]).toBe('https://api.github.com/page2');
  });

  it('stops when there is no next link, without an extra request', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(reply([issue()])));
    await port(fetchImpl).list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns every page, not just the last', async () => {
    let n = 0;
    const fetchImpl = vi.fn(() => {
      n += 1;
      const headers =
        n < 3 ? { link: `<https://api.github.com/p${String(n + 1)}>; rel="next"` } : {};
      return Promise.resolve(reply([issue({ number: n })], { headers }));
    });
    expect((await port(fetchImpl).list()).map((i) => i.id)).toEqual(['1', '2', '3']);
  });
});

describe('list — conditional requests', () => {
  it('stores the etag and sends it back on the next call', async () => {
    const seen: (string | undefined)[] = [];
    const etags = new Map<string, string>();
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.['if-none-match']);
      return Promise.resolve(reply([issue()], { headers: { etag: 'W/"abc"' } }));
    });
    const p = port(fetchImpl, { etags });
    await p.list();
    await p.list();
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe('W/"abc"');
  });

  it('treats a 304 as "nothing changed" rather than as an error', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(reply(null, { status: 304 })));
    await expect(port(fetchImpl).list()).resolves.toEqual([]);
  });

  it('does not send if-none-match on a mutation', async () => {
    // Seeded against the POST URL itself. Keying this map on anything else
    // makes the assertion vacuous — the lookup misses and reports "not sent"
    // whether or not the code would have sent it.
    const createUrl = 'https://api.github.com/repos/o/r/issues';
    const etags = new Map<string, string>([[createUrl, 'W/"abc"']]);
    let sent: string | undefined;
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      expect(url).toBe(createUrl);
      sent = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
      return Promise.resolve(reply(issue()));
    });
    await port(fetchImpl, { etags }).create({ id: 'S', title: 't', body: 'b', closed: false });
    // A conditional POST would get a 304 and be silently dropped — the write
    // would simply not happen, and the run would report success.
    expect(sent).toBeUndefined();
  });

  it('does not store an etag returned from a mutation', async () => {
    // Storing it would make the *next* read of that URL conditional on a tag
    // minted by a write, and a 304 there reads as "no issues in the repo".
    const createUrl = 'https://api.github.com/repos/o/r/issues';
    const etags = new Map<string, string>();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(reply(issue(), { headers: { etag: 'W/"new"' } })),
    );
    await port(fetchImpl, { etags }).create({ id: 'S', title: 't', body: 'b', closed: false });
    expect(etags.has(createUrl)).toBe(false);
    expect(etags.size).toBe(0);
  });
});

describe('errors', () => {
  it('names the missing permission on a 403 that is not a rate limit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(reply({}, { status: 403, headers: { 'x-ratelimit-remaining': '4999' } })),
    );
    await expect(port(fetchImpl).list()).rejects.toThrow(/missing a permission/);
  });

  it('quotes the permission GitHub named, instead of guessing at one', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        reply(
          {},
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '4981',
              'x-accepted-github-permissions': 'issues=write',
            },
          },
        ),
      ),
    );
    await expect(port(fetchImpl).list()).rejects.toThrow(/issues=write/);
  });

  it('does not retry a permissions 403', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(reply({}, { status: 403, headers: { 'x-ratelimit-remaining': '4999' } })),
    );
    await expect(port(fetchImpl).list()).rejects.toThrow(GithubApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits out a rate limit and then succeeds', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let n = 0;
    const fetchImpl = vi.fn(() => {
      n += 1;
      return Promise.resolve(
        n === 1 ? reply({}, { status: 429, headers: { 'retry-after': '30' } }) : reply([issue()]),
      );
    });
    const items = await port(fetchImpl, { sleep }).list();
    expect(sleep).toHaveBeenCalledWith(30_000);
    expect(items).toHaveLength(1);
  });

  it('gives up after maxRetries rather than retrying forever', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(reply({}, { status: 429, headers: { 'retry-after': '1' } })),
    );
    await expect(port(fetchImpl, { maxRetries: 2 }).list()).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reports a 404 without retrying it', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(reply({}, { status: 404 })));
    await expect(port(fetchImpl).list()).rejects.toThrow(/404/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('create and update', () => {
  it('POSTs a create and returns what the server actually made', async () => {
    let method: string | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      method = init?.method;
      return Promise.resolve(reply(issue({ number: 7, title: 'made' })));
    });
    const made = await port(fetchImpl).create({ id: 'S', title: 'made', body: 'b', closed: false });
    expect(method).toBe('POST');
    expect(made.id).toBe('7');
  });

  it('PATCHes an update and sends the state, since create cannot', async () => {
    let body: unknown;
    let method: string | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      method = init?.method;
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return Promise.resolve(reply(issue({ state: 'closed' })));
    });
    const out = await port(fetchImpl).update('42', {
      id: 'S',
      title: 't',
      body: 'b',
      closed: true,
    });
    expect(method).toBe('PATCH');
    expect(body).toMatchObject({ state: 'closed' });
    expect(out.closed).toBe(true);
  });

  it('returns the post-write timestamp so the cursor does not lag', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(reply(issue({ updated_at: '2026-08-23T12:00:00Z' }))),
    );
    const out = await port(fetchImpl).update('42', {
      id: 'S',
      title: 't',
      body: 'b',
      closed: false,
    });
    expect(out.updatedAt).toBe('2026-08-23T12:00:00Z');
  });

  it('addresses the right repo and issue', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(reply(issue()));
    });
    await port(fetchImpl).update('99', { id: 'S', title: 't', body: 'b', closed: false });
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/issues/99');
  });
});

describe('adopt', () => {
  it('delegates to the injected adopter rather than inventing a local id', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(reply([])));
    const out = await port(fetchImpl).adopt({
      id: '5',
      title: 't',
      body: 'b',
      closed: false,
      updatedAt: 'x',
      foreign: false,
    });
    expect(out.id).toBe('ADOPTED-5');
  });
});

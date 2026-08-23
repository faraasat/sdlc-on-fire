import { describe, expect, it } from 'vitest';
import {
  acceptedPermissions,
  isRateLimited,
  listUrl,
  MAX_PER_PAGE,
  nextPageUrl,
  readRateLimit,
  requestHeaders,
  retryDelayMs,
  toRemoteItem,
  type GithubIssue,
} from './github-issues.js';

const h = (init: Record<string, string>): Headers => new Headers(init);

const issue = (over: Partial<GithubIssue> = {}): GithubIssue => ({
  number: 42,
  title: 'a title',
  body: 'a body',
  state: 'open',
  updated_at: '2026-08-23T10:00:00Z',
  ...over,
});

describe('listUrl', () => {
  it('always asks for state=all, because the default hides remote closures', () => {
    expect(new URL(listUrl('o/r')).searchParams.get('state')).toBe('all');
  });

  it('pages at the documented maximum', () => {
    expect(new URL(listUrl('o/r')).searchParams.get('per_page')).toBe(String(MAX_PER_PAGE));
    expect(MAX_PER_PAGE).toBe(100);
  });

  it('sorts by update time ascending so an interrupted pass can resume', () => {
    const params = new URL(listUrl('o/r')).searchParams;
    expect(params.get('sort')).toBe('updated');
    expect(params.get('direction')).toBe('asc');
  });

  it('omits `since` entirely on a full pass rather than sending an empty one', () => {
    expect(new URL(listUrl('o/r')).searchParams.has('since')).toBe(false);
  });

  it('passes `since` through for an incremental pass', () => {
    const params = new URL(listUrl('o/r', { since: '2026-08-01T00:00:00Z' })).searchParams;
    expect(params.get('since')).toBe('2026-08-01T00:00:00Z');
  });
});

describe('toRemoteItem', () => {
  it('flags a pull request as foreign', () => {
    expect(toRemoteItem(issue({ pull_request: { url: 'x' } })).foreign).toBe(true);
    expect(toRemoteItem(issue()).foreign).toBe(false);
  });

  it('treats a pull_request key as foreign even when its value is null', () => {
    // Presence of the key is the documented signal, not truthiness — and a
    // truthiness check would let every PR through as a story.
    expect(toRemoteItem(issue({ pull_request: null })).foreign).toBe(true);
  });

  it('normalises a null body to empty string so it does not resync forever', () => {
    expect(toRemoteItem(issue({ body: null })).body).toBe('');
  });

  it('maps state to a boolean rather than carrying the string through', () => {
    expect(toRemoteItem(issue({ state: 'closed' })).closed).toBe(true);
    expect(toRemoteItem(issue({ state: 'open' })).closed).toBe(false);
  });

  it('carries the provider timestamp verbatim', () => {
    expect(toRemoteItem(issue({ updated_at: '2020-01-01T00:00:00Z' })).updatedAt).toBe(
      '2020-01-01T00:00:00Z',
    );
  });
});

describe('readRateLimit', () => {
  it('reads every documented header', () => {
    const limit = readRateLimit(
      h({
        'x-ratelimit-remaining': '17',
        'x-ratelimit-reset': '1790000000',
        'retry-after': '60',
        'x-poll-interval': '90',
      }),
    );
    expect(limit).toEqual({ remaining: 17, reset: 1790000000, retryAfter: 60, pollInterval: 90 });
  });

  it('reports null rather than zero for a missing header', () => {
    // Zero would read as "no budget left" and stall the sync forever.
    expect(readRateLimit(h({})).remaining).toBeNull();
  });

  it('reports null for a header that is not a number', () => {
    expect(readRateLimit(h({ 'x-ratelimit-remaining': 'soon' })).remaining).toBeNull();
  });

  it('keeps a genuine zero distinct from a missing header', () => {
    expect(readRateLimit(h({ 'x-ratelimit-remaining': '0' })).remaining).toBe(0);
  });
});

describe('isRateLimited', () => {
  const none = { remaining: null, reset: null, retryAfter: null, pollInterval: null };

  it('treats 429 as rate limited', () => {
    expect(isRateLimited(429, none)).toBe(true);
  });

  it('treats a 403 with retry-after as rate limited', () => {
    expect(isRateLimited(403, { ...none, retryAfter: 60 })).toBe(true);
  });

  it('treats a 403 with an exhausted budget as rate limited', () => {
    expect(isRateLimited(403, { ...none, remaining: 0 })).toBe(true);
  });

  it('does NOT treat a 403 with budget left as rate limited', () => {
    // That is a permissions failure. Retrying it loops forever without ever
    // saying the token is missing a scope.
    expect(isRateLimited(403, { ...none, remaining: 4_999 })).toBe(false);
  });

  it('does not treat a 404 or 200 as rate limited', () => {
    expect(isRateLimited(404, none)).toBe(false);
    expect(isRateLimited(200, none)).toBe(false);
  });
});

describe('retryDelayMs', () => {
  const none = { remaining: null, reset: null, retryAfter: null, pollInterval: null };

  it('does not retry a 404 or a 200', () => {
    expect(retryDelayMs(404, none, 0)).toBeNull();
    expect(retryDelayMs(200, none, 0)).toBeNull();
  });

  it('obeys retry-after exactly, in preference to guessing', () => {
    expect(retryDelayMs(403, { ...none, retryAfter: 42 }, 5)).toBe(42_000);
  });

  it('waits at least a minute on a secondary limit with no retry-after', () => {
    expect(retryDelayMs(403, none, 0)).toBeGreaterThanOrEqual(60_000);
  });

  it('backs off exponentially and then caps', () => {
    expect(retryDelayMs(403, none, 1)).toBe(120_000);
    expect(retryDelayMs(403, none, 99)).toBe(15 * 60_000);
  });

  it('retries a 500 quickly, since a server error is not a rate limit', () => {
    const delay = retryDelayMs(500, none, 0);
    expect(delay).not.toBeNull();
    expect(delay!).toBeLessThan(60_000);
  });
});

describe('nextPageUrl', () => {
  it('finds rel="next" among several link relations', () => {
    const link =
      '<https://api.github.com/repos/o/r/issues?page=3>; rel="next", ' +
      '<https://api.github.com/repos/o/r/issues?page=9>; rel="last"';
    expect(nextPageUrl(h({ link }))).toBe('https://api.github.com/repos/o/r/issues?page=3');
  });

  it('returns null on the final page, where only prev and last are present', () => {
    const link =
      '<https://api.github.com/repos/o/r/issues?page=8>; rel="prev", ' +
      '<https://api.github.com/repos/o/r/issues?page=9>; rel="last"';
    expect(nextPageUrl(h({ link }))).toBeNull();
  });

  it('returns null when there is no Link header at all', () => {
    expect(nextPageUrl(h({}))).toBeNull();
  });

  it('does not mistake rel="last" for rel="next" by substring', () => {
    const link = '<https://api.github.com/x?page=9>; rel="last"';
    expect(nextPageUrl(h({ link }))).toBeNull();
  });
});

describe('requestHeaders', () => {
  it('pins the API version', () => {
    expect(requestHeaders('t')['x-github-api-version']).toBe('2022-11-28');
  });

  it('sends if-none-match only when an etag is known', () => {
    expect(requestHeaders('t')['if-none-match']).toBeUndefined();
    expect(requestHeaders('t', 'W/"abc"')['if-none-match']).toBe('W/"abc"');
  });

  it('sends the token as a bearer credential', () => {
    expect(requestHeaders('tok')['authorization']).toBe('Bearer tok');
  });
});

describe('acceptedPermissions', () => {
  it('reads the permission GitHub names on a 403', () => {
    // Observed live: a POST /issues with a read-only token returns
    // `x-accepted-github-permissions: issues=write`.
    expect(acceptedPermissions(h({ 'x-accepted-github-permissions': 'issues=write' }))).toBe(
      'issues=write',
    );
  });

  it('keeps a multi-alternative value intact rather than picking one', () => {
    const value = 'issues=write, pull_requests=write';
    expect(acceptedPermissions(h({ 'x-accepted-github-permissions': value }))).toBe(value);
  });

  it('returns null when the header is absent, since it is not guaranteed', () => {
    expect(acceptedPermissions(h({}))).toBeNull();
    expect(acceptedPermissions(h({ 'x-accepted-github-permissions': '  ' }))).toBeNull();
  });
});

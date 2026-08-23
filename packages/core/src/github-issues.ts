/**
 * The GitHub Issues transport for P5-TRACK-01.
 *
 * Everything here is a rule GitHub's own best-practices page states, encoded so
 * it cannot be skipped by whoever writes the next caller. Verified against the
 * REST docs on 2026-08-22/23 (tier A — the vendor's own spec):
 *
 *   * **`state` defaults to `open`.** A sync that accepts the default never
 *     sees a remote closure: the issue simply stops appearing, and `decide`
 *     correctly reports "absent from this batch" forever. The board would drift
 *     out of date with nothing failing anywhere. `state=all` is not a
 *     preference here, it is a correctness requirement, so it is not a knob.
 *
 *   * **Every pull request is an issue on this endpoint.** "GitHub's REST API
 *     considers every pull request an issue, but not every issue is a pull
 *     request" — they arrive in the same list and are told apart only by the
 *     `pull_request` key. That maps to `foreign` on the shared shape.
 *
 *   * **`since` filters on `updated_at`, not `created_at`**, which is what
 *     makes an incremental pass possible at all.
 *
 *   * **Conditional requests are free.** A 304 against a stored ETag does not
 *     count against the primary rate limit.
 *
 *   * **Mutations go one at a time, with a gap.** GitHub asks for serial
 *     mutative requests and at least a second between them; concurrency here
 *     earns a secondary rate limit, and continuing to hammer through one risks
 *     the integration being banned outright.
 */

import type { RemoteItem } from './tracker-sync.js';

export const GITHUB_API = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const MAX_PER_PAGE = 100;
/** GitHub's stated floor between mutative requests. */
export const MUTATION_GAP_MS = 1_000;

export interface RateLimit {
  readonly remaining: number | null;
  /** UTC epoch seconds, verbatim from the header. */
  readonly reset: number | null;
  /** Seconds the server asked us to wait, when it did. */
  readonly retryAfter: number | null;
  /** Seconds the server asked us to leave between polls, when it did. */
  readonly pollInterval: number | null;
}

export function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    remaining: num('x-ratelimit-remaining'),
    reset: num('x-ratelimit-reset'),
    retryAfter: num('retry-after'),
    pollInterval: num('x-poll-interval'),
  };
}

/**
 * How long to wait before retrying, in milliseconds, or null to not retry.
 *
 * `retry-after` wins outright when present, because it is the server stating a
 * number rather than us guessing one. Otherwise GitHub's guidance is to wait at
 * least a minute and back off exponentially — so the floor is a minute, not the
 * usual sub-second first retry, and a caller that "helpfully" tightens it is
 * the caller that gets the integration banned.
 */
export function retryDelayMs(status: number, limit: RateLimit, attempt: number): number | null {
  if (status !== 403 && status !== 429 && status < 500) return null;
  if (limit.retryAfter !== null) return limit.retryAfter * 1_000;
  if (status >= 500) return Math.min(2 ** attempt * 1_000, 30_000);
  return Math.min(60_000 * 2 ** attempt, 15 * 60_000);
}

/** Whether a 403 is a rate limit rather than a genuine permission failure. */
export function isRateLimited(status: number, limit: RateLimit): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  // A 403 with budget left is not a rate limit — it is the token lacking the
  // permission. Retrying that is a loop that never terminates and never says
  // why, which is the worst shape a sync failure can take.
  return limit.retryAfter !== null || limit.remaining === 0;
}

/**
 * The permission GitHub says the request needed, when it says so.
 *
 * `x-accepted-github-permissions` comes back on a 403 and names the exact
 * requirement — `issues=write`, and sometimes several comma-separated
 * alternatives. Observed directly against the live API on 2026-08-23 (tier A:
 * the vendor's own response), not from documentation; it is absent from the
 * REST reference pages consulted this session, so treat its presence as a
 * bonus rather than a contract and always keep a fallback message.
 *
 * This matters because the alternative is guessing. An error that says
 * "probably missing the Issues permission" sends somebody to re-read a
 * permissions table; one that says `issues=write` sends them to the toggle.
 */
export function acceptedPermissions(headers: Headers): string | null {
  const raw = headers.get('x-accepted-github-permissions');
  if (raw === null || raw.trim() === '') return null;
  return raw.trim();
}

/** Parse the `Link` header's `rel="next"`, which is how this API paginates. */
export function nextPageUrl(headers: Headers): string | null {
  const link = headers.get('link');
  if (link === null) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** The raw shape we read off the API. Only the fields the sync acts on. */
export interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  updated_at: string;
  pull_request?: unknown;
}

/**
 * Map a GitHub issue onto the provider-agnostic shape.
 *
 * `body` is nullable on the API and empty-string locally; normalising here
 * rather than at each call site keeps a null from fingerprinting differently
 * than the empty body it is equivalent to, which would resync forever.
 */
export function toRemoteItem(issue: GithubIssue): RemoteItem {
  return {
    id: String(issue.number),
    title: issue.title,
    body: issue.body ?? '',
    closed: issue.state === 'closed',
    updatedAt: issue.updated_at,
    foreign: issue.pull_request !== undefined,
  };
}

/** The URL for an incremental list pass. */
export function listUrl(repo: string, options: { since?: string | undefined } = {}): string {
  const url = new URL(`${GITHUB_API}/repos/${repo}/issues`);
  // Not configurable — see the header comment.
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', String(MAX_PER_PAGE));
  // Ascending by update time, so a run interrupted partway can resume from the
  // last item it saw. Descending would make a partial pass unresumable.
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  if (options.since !== undefined) url.searchParams.set('since', options.since);
  return url.toString();
}

export function requestHeaders(token: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    authorization: `Bearer ${token}`,
  };
  if (etag !== undefined) headers['if-none-match'] = etag;
  return headers;
}

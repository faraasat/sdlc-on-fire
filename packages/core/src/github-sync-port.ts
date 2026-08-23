/**
 * `SyncPort` over GitHub Issues (P5-TRACK-01).
 *
 * The transport rules live in `github-issues.ts`; this is where they are
 * actually obeyed — pagination followed to the end, ETags stored and sent,
 * rate limits waited out rather than retried through.
 *
 * `fetch` and `sleep` are injected. Not for testability alone: it means the
 * retry path can be exercised without a fifteen-minute test, and a retry path
 * that has never been executed is indistinguishable from one that is broken.
 */

import {
  acceptedPermissions,
  isRateLimited,
  listUrl,
  nextPageUrl,
  readRateLimit,
  requestHeaders,
  retryDelayMs,
  toRemoteItem,
  type GithubIssue,
} from './github-issues.js';
import type { SyncPort } from './sync-engine.js';
import type { LocalItem, RemoteItem } from './tracker-sync.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubPortOptions {
  /** `owner/repo`. */
  readonly repo: string;
  readonly token: string;
  readonly fetch?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** How many times to wait out a rate limit before giving up. */
  readonly maxRetries?: number | undefined;
  /** ETags from the previous run, by URL. Mutated in place as pages are read. */
  readonly etags?: Map<string, string> | undefined;
  /** Called when the local id for an adopted remote item must be minted. */
  readonly adopt: (remote: RemoteItem) => Promise<LocalItem>;
}

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createGithubPort(options: GithubPortOptions): SyncPort {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const maxRetries = options.maxRetries ?? 3;
  const etags = options.etags ?? new Map<string, string>();

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const etag = init.method === undefined ? etags.get(url) : undefined;
      const response = await doFetch(url, {
        ...init,
        headers: { ...requestHeaders(options.token, etag), ...(init.headers ?? {}) },
      });

      if (response.ok || response.status === 304) {
        const fresh = response.headers.get('etag');
        if (fresh !== null && init.method === undefined) etags.set(url, fresh);
        return response;
      }

      const limit = readRateLimit(response.headers);
      // A 403 with budget left is the token missing a permission. Surfacing it
      // immediately, by name, beats a retry loop that ends fifteen minutes
      // later with a message about rate limits that was never true.
      if (response.status === 403 && !isRateLimited(response.status, limit)) {
        const needed = acceptedPermissions(response.headers);
        throw new GithubApiError(
          needed === null
            ? `GitHub refused the request (403) for ${options.repo}. The token is missing a permission this call requires.`
            : `GitHub refused the request (403) for ${options.repo}. It requires the permission: ${needed}.`,
          403,
        );
      }

      const delay = retryDelayMs(response.status, limit, attempt);
      if (delay === null || attempt >= maxRetries) {
        throw new GithubApiError(
          `GitHub returned ${String(response.status)} for ${url}${delay === null ? '' : ` after ${String(attempt + 1)} attempt(s)`}`,
          response.status,
        );
      }
      await sleep(delay);
    }
  }

  return {
    async list(since?: string): Promise<readonly RemoteItem[]> {
      const items: RemoteItem[] = [];
      let url: string | null = listUrl(options.repo, { since });
      while (url !== null) {
        const response: Response = await request(url);
        if (response.status === 304) break; // unchanged; nothing further on this page
        const page = (await response.json()) as GithubIssue[];
        for (const issue of page) items.push(toRemoteItem(issue));
        // Follow the Link header rather than incrementing a page counter.
        // Counting pages past the end returns an empty array rather than an
        // error, so a counter-driven loop terminates by luck, and a
        // counter-driven loop with an off-by-one silently truncates the sync.
        url = nextPageUrl(response.headers);
      }
      return items;
    },

    async create(local: LocalItem): Promise<RemoteItem> {
      const response = await request(`https://api.github.com/repos/${options.repo}/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: local.title, body: local.body }),
      });
      const issue = (await response.json()) as GithubIssue;
      // A freshly created issue is open regardless of what we asked for — the
      // create endpoint takes no state. Closing is a second call, so the caller
      // gets the truth rather than what it hoped for.
      return toRemoteItem(issue);
    },

    async update(remoteId: string, local: LocalItem): Promise<RemoteItem> {
      const response = await request(
        `https://api.github.com/repos/${options.repo}/issues/${remoteId}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: local.title,
            body: local.body,
            state: local.closed ? 'closed' : 'open',
          }),
        },
      );
      return toRemoteItem((await response.json()) as GithubIssue);
    },

    adopt(remote: RemoteItem): Promise<LocalItem> {
      return options.adopt(remote);
    },
  };
}

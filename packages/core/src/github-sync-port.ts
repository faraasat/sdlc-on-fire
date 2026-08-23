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

  /**
   * `conditional: false` opts a request out of ETag revalidation entirely.
   *
   * **Listing must never be conditional.** A 304 says "not modified"; it
   * carries no body. A list call that treats that as an empty array is
   * reporting "this repository has no issues", and the two are indistinguishable
   * downstream. An unlinked local item paired against an empty remote list
   * decides `create-remote` — so a conditional list duplicates every unsynced
   * item on every run, silently, and each duplicate then becomes a real remote
   * item that duplicates again.
   *
   * Returning a cached body instead would need the *items* persisted beside the
   * ETag across runs, not just within one; with only the ETag persisted, the
   * first list of a new process 304s into an empty cache and the bug returns.
   * So the saving is declined: a sync lists one or two pages per run against a
   * 5,000/hour budget, and correctness is not worth trading for that.
   *
   * Observed live on 2026-08-23 — a repeat list 304'd and produced `n=0` while
   * the repository held nine issues.
   */
  async function request(
    url: string,
    init: RequestInit & { conditional?: boolean } = {},
  ): Promise<Response> {
    const { conditional, ...rest } = init;
    for (let attempt = 0; ; attempt += 1) {
      const mayRevalidate = rest.method === undefined && conditional !== false;
      const etag = mayRevalidate ? etags.get(url) : undefined;
      const response = await doFetch(url, {
        ...rest,
        headers: { ...requestHeaders(options.token, etag), ...(rest.headers ?? {}) },
      });

      if (response.ok || response.status === 304) {
        const fresh = response.headers.get('etag');
        if (fresh !== null && mayRevalidate) etags.set(url, fresh);
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
      // Deliberately unconditional — see `listUnconditional` below.
      let url: string | null = listUrl(options.repo, { since });
      while (url !== null) {
        const response: Response = await request(url, { conditional: false });
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

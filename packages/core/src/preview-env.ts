/**
 * Preview-environment integration (P5-ECO-02).
 *
 * A deploy preview is evidence: it is a URL where a reviewer can see the change
 * running, and attaching it to a review gate is the difference between "looks
 * right in the diff" and "I opened it".
 *
 * **This calls nothing.** Vercel, Netlify and Fly all announce a preview the
 * same way — an environment variable in the build, or a webhook payload — and
 * both arrive at us rather than being fetched. So the whole integration is
 * parsing and validation, which means it is deterministic, offline, and
 * testable without an account on any of them (ADR-0040). A version that polled
 * a provider API would need credentials to test and would be verified by
 * nobody.
 *
 * **A preview URL is evidence with an expiry.** Preview deployments are torn
 * down — by the provider's retention policy, or when the branch merges — so a
 * gate that recorded one as permanent proof would, months later, point a
 * reviewer at a 404 and call it verification. Every attachment carries the
 * commit it was built from, and staleness is decided against that rather than
 * against the clock.
 */

export const PREVIEW_PROVIDERS = ['vercel', 'netlify', 'fly', 'generic'] as const;
export type PreviewProvider = (typeof PREVIEW_PROVIDERS)[number];

export interface PreviewDeployment {
  readonly provider: PreviewProvider;
  readonly url: string;
  /** The commit this preview was built from. What staleness is judged against. */
  readonly commit: string;
  readonly branch?: string | undefined;
}

export interface PreviewProblem {
  readonly field: string;
  readonly because: string;
}

/**
 * The environment variables each provider exposes inside a build.
 *
 * Read from the environment we were handed rather than from `process.env`
 * directly, so this stays a pure function and a test does not have to mutate
 * global state to exercise a provider it has never used.
 */
const PROVIDER_ENV: Record<
  Exclude<PreviewProvider, 'generic'>,
  { url: readonly string[]; commit: readonly string[]; branch: readonly string[] }
> = {
  vercel: {
    url: ['VERCEL_URL', 'VERCEL_BRANCH_URL'],
    commit: ['VERCEL_GIT_COMMIT_SHA'],
    branch: ['VERCEL_GIT_COMMIT_REF'],
  },
  netlify: {
    url: ['DEPLOY_PRIME_URL', 'DEPLOY_URL'],
    commit: ['COMMIT_REF'],
    branch: ['HEAD', 'BRANCH'],
  },
  fly: {
    url: ['FLY_APP_URL'],
    commit: ['FLY_GIT_COMMIT', 'GIT_COMMIT_SHA'],
    branch: ['FLY_GIT_BRANCH'],
  },
};

const first = (
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
};

/**
 * Normalise a URL a provider handed us.
 *
 * Vercel's `VERCEL_URL` has no scheme, which is the single most common way this
 * integration breaks: the value looks like a URL, is stored as one, and is
 * unopenable. Everything else is left alone — rewriting a URL a provider gave
 * us is how a working link becomes a broken one.
 */
export function normalisePreviewUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    // http is refused rather than upgraded: a preview served over plain http is
    // a different thing from one served over TLS, and silently changing the
    // scheme would attach a URL nobody deployed.
    if (url.protocol !== 'https:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Read a preview out of a build environment, or say why there isn't one. */
export function previewFromEnv(env: Record<string, string | undefined>): {
  preview: PreviewDeployment | null;
  problems: readonly PreviewProblem[];
} {
  for (const provider of ['vercel', 'netlify', 'fly'] as const) {
    const spec = PROVIDER_ENV[provider];
    const rawUrl = first(env, spec.url);
    if (rawUrl === undefined) continue;

    const problems: PreviewProblem[] = [];
    const url = normalisePreviewUrl(rawUrl);
    if (url === null) {
      problems.push({ field: 'url', because: `"${rawUrl}" is not an https URL` });
    }

    const commit = first(env, spec.commit);
    if (commit === undefined) {
      // Refused rather than defaulted to HEAD. A preview attributed to the
      // wrong commit is worse than an unattributed one: it makes a reviewer
      // believe they looked at the change they are approving.
      problems.push({
        field: 'commit',
        because: `${provider} exposed a preview URL but no commit — the preview cannot be tied to what it was built from`,
      });
    }

    if (problems.length > 0 || url === null || commit === undefined) {
      return { preview: null, problems };
    }
    const branch = first(env, spec.branch);
    return {
      preview: { provider, url, commit, ...(branch === undefined ? {} : { branch }) },
      problems: [],
    };
  }
  return { preview: null, problems: [] };
}

/**
 * Whether a recorded preview still describes the commit under review.
 *
 * Compared on the commit, never on age. A preview built an hour ago from the
 * wrong commit is stale; one built last week from this commit is not.
 */
export function isPreviewCurrent(preview: PreviewDeployment, headCommit: string): boolean {
  const a = preview.commit.trim().toLowerCase();
  const b = headCommit.trim().toLowerCase();
  // Prefix comparison, because providers truncate SHAs to varying lengths and
  // a strict equality check would call every short SHA stale. The length floor
  // is also what rejects an empty commit — no separate emptiness guard, because
  // a guard that can never fire reads like protection and provides none.
  const short = Math.min(a.length, b.length);
  return short >= 7 && a.slice(0, short) === b.slice(0, short);
}

/** The evidence line a gate records. Says what it is *and* what it is not. */
export function previewEvidence(preview: PreviewDeployment, headCommit: string): string {
  const current = isPreviewCurrent(preview, headCommit);
  return current
    ? `${preview.provider} preview of ${preview.commit.slice(0, 7)}: ${preview.url} — a place to look, not a check that ran`
    : `${preview.provider} preview is STALE: built from ${preview.commit.slice(0, 7)}, review is of ${headCommit.slice(0, 7)}`;
}

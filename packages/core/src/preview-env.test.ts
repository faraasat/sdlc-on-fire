import { describe, expect, it } from 'vitest';
import {
  isPreviewCurrent,
  normalisePreviewUrl,
  previewEvidence,
  previewFromEnv,
} from './preview-env.js';

/**
 * P5-ECO-02 — deploy previews as gate evidence.
 *
 * Two failures drive this file. A preview attributed to the wrong commit makes
 * a reviewer believe they looked at the change they are approving. And a
 * preview recorded as permanent proof points at a 404 months later and calls it
 * verification.
 */

describe('normalisePreviewUrl', () => {
  it('adds the scheme Vercel omits', () => {
    // The single most common way this breaks: `VERCEL_URL` has no scheme, so
    // the value looks like a URL, is stored as one, and is unopenable.
    expect(normalisePreviewUrl('my-app-abc123.vercel.app')).toBe(
      'https://my-app-abc123.vercel.app',
    );
  });

  it('leaves a complete URL alone', () => {
    expect(normalisePreviewUrl('https://deploy-preview-7--site.netlify.app')).toBe(
      'https://deploy-preview-7--site.netlify.app',
    );
  });

  it('refuses http rather than silently upgrading it', () => {
    // Changing the scheme would attach a URL nobody deployed.
    expect(normalisePreviewUrl('http://insecure.example.com')).toBeNull();
  });

  it('refuses something that is not a URL', () => {
    expect(normalisePreviewUrl('  ')).toBeNull();
    expect(normalisePreviewUrl('not a url at all !!')).toBeNull();
  });

  it('drops a trailing slash so two records of one preview compare equal', () => {
    expect(normalisePreviewUrl('https://x.vercel.app/')).toBe('https://x.vercel.app');
  });
});

describe('previewFromEnv', () => {
  it('reads a Vercel build', () => {
    const { preview } = previewFromEnv({
      VERCEL_URL: 'app-xyz.vercel.app',
      VERCEL_GIT_COMMIT_SHA: 'abc1234def',
      VERCEL_GIT_COMMIT_REF: 'feature/x',
    });
    expect(preview).toEqual({
      provider: 'vercel',
      url: 'https://app-xyz.vercel.app',
      commit: 'abc1234def',
      branch: 'feature/x',
    });
  });

  it('reads a Netlify build', () => {
    const { preview } = previewFromEnv({
      DEPLOY_PRIME_URL: 'https://deploy-preview-7--site.netlify.app',
      COMMIT_REF: 'deadbeef123',
    });
    expect(preview?.provider).toBe('netlify');
  });

  it('reads a Fly build', () => {
    const { preview } = previewFromEnv({
      FLY_APP_URL: 'https://app.fly.dev',
      FLY_GIT_COMMIT: 'cafebabe99',
    });
    expect(preview?.provider).toBe('fly');
  });

  it('refuses a preview with no commit rather than assuming HEAD', () => {
    // A preview attributed to the wrong commit is worse than an unattributed
    // one — it makes a reviewer believe they looked at the change.
    const { preview, problems } = previewFromEnv({ VERCEL_URL: 'app.vercel.app' });
    expect(preview).toBeNull();
    expect(problems.some((p) => p.field === 'commit')).toBe(true);
  });

  it('reports an unusable URL rather than storing it', () => {
    const { preview, problems } = previewFromEnv({
      VERCEL_URL: 'not a url !!',
      VERCEL_GIT_COMMIT_SHA: 'abc1234',
    });
    expect(preview).toBeNull();
    expect(problems.some((p) => p.field === 'url')).toBe(true);
  });

  it('finds nothing, quietly, outside a preview build', () => {
    // Not an error: most builds are not preview deploys.
    expect(previewFromEnv({ CI: 'true' })).toEqual({ preview: null, problems: [] });
  });

  it('ignores an empty variable rather than treating it as set', () => {
    expect(previewFromEnv({ VERCEL_URL: '   ' }).preview).toBeNull();
  });
});

describe('isPreviewCurrent', () => {
  it('matches a full SHA against a truncated one', () => {
    // Providers truncate to varying lengths; strict equality would call every
    // short SHA stale.
    expect(
      isPreviewCurrent(
        { provider: 'vercel', url: 'https://x', commit: 'abc1234' },
        'abc1234def567',
      ),
    ).toBe(true);
  });

  it('rejects a different commit', () => {
    expect(
      isPreviewCurrent({ provider: 'vercel', url: 'https://x', commit: 'abc1234' }, 'fff9999'),
    ).toBe(false);
  });

  it('refuses a prefix too short to mean anything', () => {
    // Three hex characters collide constantly; matching on them would report
    // agreement between unrelated commits.
    expect(
      isPreviewCurrent({ provider: 'fly', url: 'https://x', commit: 'abc' }, 'abcdef123'),
    ).toBe(false);
  });

  it('is false for an empty commit rather than vacuously true', () => {
    expect(isPreviewCurrent({ provider: 'fly', url: 'https://x', commit: '' }, 'abcdef1')).toBe(
      false,
    );
  });

  it('judges staleness on the commit, never on age', () => {
    // A preview built an hour ago from the wrong commit is stale; one built
    // last week from this commit is not.
    const old = { provider: 'netlify' as const, url: 'https://x', commit: 'abcdef1234' };
    expect(isPreviewCurrent(old, 'abcdef1234')).toBe(true);
  });
});

describe('previewEvidence', () => {
  it('says a preview is a place to look, not a check that ran', () => {
    // The distinction the whole product turns on.
    const line = previewEvidence(
      { provider: 'vercel', url: 'https://x.vercel.app', commit: 'abcdef1234' },
      'abcdef1234',
    );
    expect(line).toContain('not a check that ran');
  });

  it('says STALE loudly when the commit moved on', () => {
    const line = previewEvidence(
      { provider: 'vercel', url: 'https://x.vercel.app', commit: 'abcdef1234' },
      '999888777',
    );
    expect(line).toContain('STALE');
    expect(line).toContain('abcdef1');
    expect(line).toContain('9998887');
  });
});

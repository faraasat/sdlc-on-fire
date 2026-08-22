import { describe, expect, it } from 'vitest';
import {
  advanceLatest,
  alreadyPublished,
  distTagAddCommand,
  distTagFor,
  publishFlags,
  publishStdio,
  registryTags,
  shouldAdvanceLatest,
} from './publish.mjs';

/**
 * The dist-tag rule (P0-META-03).
 *
 * This one line decides what a bare `npm install sdlc-on-fire` resolves to.
 * npm defaults to `latest` when no tag is passed, so publishing a prerelease
 * without one serves the alpha to everyone who typed the plain command — and
 * the only way back is publishing something else on top of it.
 */

describe('distTagFor', () => {
  it('sends a prerelease to `next`', () => {
    expect(distTagFor('0.1.0-alpha.0')).toBe('next');
    expect(distTagFor('1.0.0-rc.3')).toBe('next');
    expect(distTagFor('0.2.0-beta.11')).toBe('next');
  });

  it('sends a stable version to `latest`', () => {
    expect(distTagFor('0.1.0')).toBe('latest');
    expect(distTagFor('1.2.3')).toBe('latest');
  });

  it('does not read build metadata as a prerelease', () => {
    // `1.0.0+build.5` is a stable release carrying build metadata. Treating the
    // `+` as prerelease would hide a real release behind the `next` tag.
    expect(distTagFor('1.0.0+build.5')).toBe('latest');
  });
});

describe('publishFlags', () => {
  it('attaches provenance in CI, where npm can mint an OIDC attestation', () => {
    expect(publishFlags({ GITHUB_ACTIONS: 'true' }).provenance).toBe(true);
    expect(publishFlags({ GITHUB_ACTIONS: 'true' }).flags).toContain('--provenance');
  });

  it('omits provenance outside CI rather than failing the publish', () => {
    // `--provenance` does not degrade on a laptop, it fails the publish. That
    // matters for exactly one release: the first, which cannot come from CI
    // because Trusted Publishing is configured on a package that does not
    // exist yet.
    const { provenance, flags } = publishFlags({});
    expect(provenance).toBe(false);
    expect(flags).not.toContain('--provenance');
  });

  it('always publishes with public access', () => {
    // Scoped packages default to restricted, which for a free account is a
    // publish error rather than a private package.
    expect(publishFlags({}).flags).toContain('--access');
    expect(publishFlags({}).flags).toContain('public');
    expect(publishFlags({ CI: 'true' }).flags).toContain('public');
  });
});

describe('publishStdio', () => {
  it('inherits stdin on a real publish, so npm can ask for the OTP', () => {
    // An account with 2FA on publishing gets EOTP and npm offers to complete
    // the flow interactively. With stdin ignored it cannot ask, and the publish
    // dies on the first package with an error that reads like a config problem
    // and is actually a closed channel. `--dry-run` needs no OTP, so the
    // rehearsal passes cleanly right before the real run fails.
    expect(publishStdio(false)[0]).toBe('inherit');
  });

  it('inherits stderr in both modes', () => {
    // A failure is never the quiet one.
    expect(publishStdio(false)[2]).toBe('inherit');
    expect(publishStdio(true)[2]).toBe('inherit');
  });

  it('suppresses only the rehearsal’s stdout', () => {
    // The dry run prints a full tarball manifest nine times over, which buries
    // the one line per package that matters.
    expect(publishStdio(true)[1]).toBe('ignore');
    expect(publishStdio(false)[1]).toBe('inherit');
  });
});

/**
 * The resume guard (P0-META-03).
 *
 * This decides whether a re-run after a partial release finishes the job or
 * skips everything and reports success over an empty upload. It sits on the
 * recovery path of every interactive publish: 2FA returns `EOTP` partway
 * through a ten-package release, and the remedy is to run the command again.
 *
 * The behaviour it depends on was checked against the live registry:
 * `npm view @sdlc-on-fire/core@0.1.0-alpha.1 version` exits 1 while
 * `@0.1.0-alpha.0` exits 0, so a version that does not exist on a package that
 * does is an error, not an empty success. These tests pin that reading — if a
 * refactor makes the probe swallow the non-zero exit, the release becomes a
 * no-op that prints "published" and this goes red instead.
 */

describe('alreadyPublished', () => {
  const throws = () => {
    throw new Error('npm ERR! code E404');
  };

  it('treats a resolvable version as already on the registry', () => {
    expect(alreadyPublished('@sdlc-on-fire/core', '0.1.0-alpha.0', () => '0.1.0-alpha.0\n')).toBe(
      true,
    );
  });

  it('treats a missing version on an existing package as not published', () => {
    // The case that makes the release resumable. npm exits non-zero here rather
    // than returning an empty result, so the publish proceeds for this package.
    expect(alreadyPublished('@sdlc-on-fire/core', '0.1.0-alpha.1', throws)).toBe(false);
  });

  it('treats an entirely unpublished package as not published', () => {
    expect(alreadyPublished('@sdlc-on-fire/ui', '0.1.0-alpha.1', throws)).toBe(false);
  });

  it('asks the registry about the exact version, never the package alone', () => {
    // `npm view <pkg> version` reports the *latest* version and exits 0 for any
    // published package, which would report every package as already released
    // and skip the entire upload.
    const seen: string[][] = [];
    alreadyPublished('@sdlc-on-fire/core', '0.1.0-alpha.1', (_file, args) => {
      seen.push(args);
      throw new Error('E404');
    });
    expect(seen).toEqual([['view', '@sdlc-on-fire/core@0.1.0-alpha.1', 'version']]);
  });
});

/**
 * The `latest` correction (P0-META-03, ADR-0033).
 *
 * `distTagFor` above is right and was not enough. npm sets `latest` on a
 * package's *first* publish regardless of `--tag` — there is no `latest` yet,
 * so the registry creates one pointing at whatever was uploaded. Observed on
 * the live registry: all nine packages went up at `0.1.0-alpha.0` with
 * `--tag next` already in the script, and every one came back
 * `latest: 0.1.0-alpha.0`. Publishing `0.1.0-alpha.1` to `next` left that
 * alone, so for eight days `npm install sdlc-on-fire` resolved to alpha.0 —
 * the version whose `sdlc tiers` reports a passing suite it never ran, which
 * is the defect alpha.1 shipped to fix.
 *
 * Everything below runs against an injected runner, the same seam
 * `alreadyPublished` uses. Proving a tag rule by mutating the real registry is
 * not a test; it is a release.
 */

describe('registryTags', () => {
  const view = (payload: unknown) => () => JSON.stringify(payload);

  it('reads the hyphenated `dist-tags` field, not a `distTags` property', () => {
    // `view.distTags` is `undefined` on this payload, which would silently
    // disable the whole correction rather than fail anything.
    const snapshot = registryTags(
      'sdlc-on-fire',
      view({ 'dist-tags': { next: '0.1.0-alpha.1', latest: '0.1.0-alpha.0' }, versions: [] }),
    );
    expect(snapshot?.distTags['latest']).toBe('0.1.0-alpha.0');
    expect(snapshot?.distTags['next']).toBe('0.1.0-alpha.1');
  });

  it('normalises `versions` rather than trusting npm to hand back an array', () => {
    // npm's `--json` shape depends on the number of fields requested: one field
    // collapses to the bare value, two return an object keyed by field name.
    // Verified live. So the argument list below is load-bearing, and dropping a
    // field from it would reshape `versions` into something `.some()` throws
    // on — inside a release, after the upload. Normalising costs one line.
    const snapshot = registryTags(
      '@sdlc-on-fire/ui',
      view({ 'dist-tags': { latest: '0.1.0-alpha.0' }, versions: '0.1.0-alpha.0' }),
    );
    expect(snapshot?.versions).toEqual(['0.1.0-alpha.0']);
  });

  it('survives a package whose only version is the one just published', () => {
    // The first-publish case, which is the one this whole path exists for.
    const snapshot = registryTags(
      '@sdlc-on-fire/ui',
      view({ 'dist-tags': { latest: '0.1.0-alpha.0' }, versions: ['0.1.0-alpha.0'] }),
    );
    expect(snapshot?.versions).toEqual(['0.1.0-alpha.0']);
  });

  it('asks for both fields in one call', () => {
    const seen: string[][] = [];
    registryTags('sdlc-on-fire', (_file, args) => {
      seen.push(args);
      return JSON.stringify({ 'dist-tags': {}, versions: [] });
    });
    expect(seen).toEqual([['view', 'sdlc-on-fire', 'dist-tags', 'versions', '--json']]);
  });

  it('returns null when the registry cannot answer', () => {
    // A lookup failure is not a reason to fail a release whose packages are
    // already uploaded.
    expect(
      registryTags('sdlc-on-fire', () => {
        throw new Error('npm ERR! network');
      }),
    ).toBeNull();
    expect(registryTags('sdlc-on-fire', () => 'not json')).toBeNull();
  });
});

describe('shouldAdvanceLatest', () => {
  const snapshot = (latest: string | null, versions: string[], next = '0.1.0-alpha.1') => ({
    distTags: { ...(latest === null ? {} : { latest }), next },
    versions,
  });

  it('moves `latest` forward off the prerelease npm stranded it on', () => {
    // The observed 0.1.0-alpha.0 → 0.1.0-alpha.1 case, exactly.
    expect(
      shouldAdvanceLatest(
        '0.1.0-alpha.1',
        snapshot('0.1.0-alpha.0', ['0.1.0-alpha.0', '0.1.0-alpha.1']),
      ),
    ).toBe(true);
  });

  it('orders prereleases by semver, not lexicographically', () => {
    // `0.1.0-alpha.10` is newer than `0.1.0-alpha.9` and sorts before it as a
    // string. A string compare here would leave `latest` a version behind and
    // report success.
    expect(
      shouldAdvanceLatest('0.1.0-alpha.10', snapshot('0.1.0-alpha.9', ['0.1.0-alpha.9'])),
    ).toBe(true);
  });

  it('never moves `latest` backwards', () => {
    // A backport — publishing 0.1.1-alpha.0 while 0.2.0-alpha.0 is already out
    // — is the shape that would do it, and it is the same defect reversed.
    expect(
      shouldAdvanceLatest(
        '0.1.1-alpha.0',
        snapshot('0.2.0-alpha.0', ['0.1.0-alpha.0', '0.2.0-alpha.0']),
      ),
    ).toBe(false);
  });

  it('stops for good once any stable release exists', () => {
    // From the first stable version onward, `latest` is spoken for and
    // `distTagFor` is the only thing that should ever put anything on it.
    expect(
      shouldAdvanceLatest('0.2.0-alpha.1', snapshot('0.2.0-alpha.0', ['0.1.0', '0.2.0-alpha.0'])),
    ).toBe(false);
  });

  it('leaves a stable `latest` alone', () => {
    expect(shouldAdvanceLatest('0.2.0-alpha.0', snapshot('0.1.0', ['0.1.0']))).toBe(false);
  });

  it('does nothing when the version just published is itself stable', () => {
    // `distTagFor` already sent it to `latest`; npm did the work.
    expect(
      shouldAdvanceLatest('0.1.0', snapshot('0.1.0-alpha.1', ['0.1.0-alpha.1', '0.1.0'])),
    ).toBe(false);
  });

  it('does nothing when `latest` is already correct', () => {
    expect(shouldAdvanceLatest('0.1.0-alpha.1', snapshot('0.1.0-alpha.1', ['0.1.0-alpha.1']))).toBe(
      false,
    );
  });

  it('does not guess when there is no `latest` tag or no snapshot at all', () => {
    // No `latest` is a state only a manual `npm dist-tag rm` produces, and a
    // null snapshot means the registry never answered. Neither is a mandate.
    expect(shouldAdvanceLatest('0.1.0-alpha.1', snapshot(null, ['0.1.0-alpha.1']))).toBe(false);
    expect(shouldAdvanceLatest('0.1.0-alpha.1', null)).toBe(false);
  });
});

describe('advanceLatest', () => {
  it('tags the exact version just published', () => {
    const seen: string[][] = [];
    const result = advanceLatest('sdlc-on-fire', '0.1.0-alpha.1', (_file, args) => {
      seen.push(args);
      return '';
    });
    expect(seen).toEqual([['dist-tag', 'add', 'sdlc-on-fire@0.1.0-alpha.1', 'latest']]);
    expect(result.moved).toBe(true);
  });

  it('inherits stdin, so npm can prompt for the OTP', () => {
    // `npm dist-tag add` reaches the registry through the same `otplease()`
    // wrapper as `npm publish`, so a 2FA account is asked for a one-time
    // password here too. With stdin ignored npm cannot ask.
    let stdio: unknown;
    advanceLatest('sdlc-on-fire', '0.1.0-alpha.1', (_file, _args, options) => {
      stdio = options?.['stdio'];
      return '';
    });
    expect(Array.isArray(stdio) ? stdio[0] : undefined).toBe('inherit');
  });

  it('degrades to a reason instead of throwing when the OTP is unavailable', () => {
    // This runs after the tarball is on the registry. Throwing here would
    // report a failed release that actually succeeded — and would do it on the
    // likeliest path for a 2FA account, and the only path an unattended run
    // has.
    const result = advanceLatest('sdlc-on-fire', '0.1.0-alpha.1', () => {
      throw new Error('npm ERR! code EOTP\nThis operation requires a one-time password');
    });
    expect(result.moved).toBe(false);
    expect(result.reason).toContain('EOTP');
  });
});

describe('distTagAddCommand', () => {
  it('prints the command a human can paste when automation cannot', () => {
    expect(distTagAddCommand('@sdlc-on-fire/core', '0.1.0-alpha.1')).toBe(
      'npm dist-tag add @sdlc-on-fire/core@0.1.0-alpha.1 latest',
    );
  });
});

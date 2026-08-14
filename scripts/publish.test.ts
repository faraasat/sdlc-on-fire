import { describe, expect, it } from 'vitest';
import { distTagFor, publishFlags, publishStdio } from './publish.mjs';

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

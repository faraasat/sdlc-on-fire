import { describe, expect, it } from 'vitest';
import { distTagFor } from './publish.mjs';

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

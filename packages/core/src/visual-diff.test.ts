import { describe, expect, it } from 'vitest';
import {
  compareAll,
  compareEnvironments,
  DEFAULT_NOISE_POLICY,
  formatEnvironmentReport,
  type EnvironmentShot,
} from './visual-diff.js';

/**
 * P3-UI-05 — cross-environment comparison.
 *
 * Not "did this change alter the UI" but "do two deployments of the same commit
 * render the same". It catches fonts that 404 in production, CDN differences,
 * missing assets, locale and timezone defaults — none of which are code
 * changes, so no amount of regression testing sees them.
 */

const shot = (over: Partial<EnvironmentShot> = {}): EnvironmentShot => ({
  environment: 'staging',
  url: 'https://staging.example',
  page: '/board',
  differingPixels: 0,
  totalPixels: 1_000_000,
  ...over,
});

describe('compareEnvironments', () => {
  it('matches when the difference is inside the noise allowance', () => {
    const result = compareEnvironments(
      shot({ differingPixels: 5_000 }),
      shot({ environment: 'production', differingPixels: 5_000 }),
    );
    expect(result.verdict).toBe('match');
  });

  it('reports a difference above the allowance, and says where to look', () => {
    const result = compareEnvironments(
      shot({ differingPixels: 50_000 }),
      shot({ environment: 'production', differingPixels: 50_000 }),
    );
    expect(result.verdict).toBe('differs');
    expect(result.because).toMatch(/fonts, missing assets, locale or timezone/);
  });

  it('never allows a zero threshold to be the default', () => {
    // Two machines rendering identical HTML disagree on anti-aliased text. A
    // threshold of zero makes every run red, which is the same as no check at
    // all, only noisier.
    expect(DEFAULT_NOISE_POLICY.maxDiffPixelRatio).toBeGreaterThan(0);
  });

  it('calls a comparison unusable rather than passing or failing it', () => {
    // The verdict that keeps this honest. A comparison that could not look has
    // not found a difference; calling it `differs` trains people to ignore the
    // report, and calling it `match` is a lie.
    expect(compareEnvironments(shot({ totalPixels: 0 }), shot()).verdict).toBe('unusable');
    expect(compareEnvironments(shot(), shot({ page: '/other' })).verdict).toBe('unusable');
  });

  it('refuses to compare captures of different sizes', () => {
    // A ratio computed across mismatched canvases is arithmetic, not a
    // comparison.
    const result = compareEnvironments(shot(), shot({ totalPixels: 2_000_000 }));
    expect(result.verdict).toBe('unusable');
    expect(result.because).toContain('fixed viewport');
  });

  it('refuses to trust a comparison taken without freezing animations', () => {
    // Any difference found is as likely to be a frame boundary as an
    // environment, and a report that cannot tell those apart is noise.
    const result = compareEnvironments(shot({ differingPixels: 90_000 }), shot(), {
      ...DEFAULT_NOISE_POLICY,
      animationsDisabled: false,
    });
    expect(result.verdict).toBe('unusable');
    expect(result.because).toContain('frame boundary');
  });

  it('takes the larger of the two differing counts', () => {
    // Either side may be the one that rendered oddly; taking the smaller would
    // let a difference hide behind whichever capture was measured first.
    const result = compareEnvironments(
      shot({ differingPixels: 1_000 }),
      shot({ differingPixels: 90_000 }),
    );
    expect(result.verdict).toBe('differs');
  });

  it('reports the ratio so a threshold can be argued with', () => {
    const result = compareEnvironments(shot({ differingPixels: 20_000 }), shot());
    expect(result.ratio).toBeCloseTo(0.02, 5);
  });
});

describe('compareAll', () => {
  it('counts the three verdicts separately', () => {
    const report = compareAll([
      [shot(), shot()],
      [shot({ differingPixels: 500_000 }), shot()],
      [shot({ totalPixels: 0 }), shot()],
    ]);
    expect(report).toMatchObject({ matched: 1, differing: 1, unusable: 1 });
  });
});

describe('formatEnvironmentReport', () => {
  it('says plainly that an unusable comparison is not a pass', () => {
    // A summary that only counts failures reads as though everything else
    // passed.
    const text = formatEnvironmentReport(compareAll([[shot({ totalPixels: 0 }), shot()]]));
    expect(text).toContain('failed to look');
  });

  it('does not add the warning when everything was comparable', () => {
    expect(formatEnvironmentReport(compareAll([[shot(), shot()]]))).not.toContain('failed to look');
  });
});

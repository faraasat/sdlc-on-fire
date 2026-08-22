/**
 * Comparing two deployments of the same commit (P3-UI-05,
 * `.research/techniques/43` §3).
 *
 * A different question from visual regression, and the difference is the whole
 * point. Regression asks *"did this change alter the UI"* — one commit against
 * its own baseline. This asks *"do two deployments of the same commit render
 * the same"*, which catches a class nothing else does: fonts that resolve on
 * staging and 404 in production, CDN configuration, missing assets, locale and
 * timezone defaults. None of those are code changes, so no amount of
 * regression testing sees them.
 *
 * The design constraint every source agrees on: **pixel diffing is solved, and
 * the entire difficulty is suppressing noise.** A cross-environment comparison
 * without a noise policy produces a diff on every run and is ignored within a
 * week — so the policy is a first-class input here rather than a setting
 * somebody remembers to configure.
 */

export interface EnvironmentShot {
  readonly environment: string;
  readonly url: string;
  readonly page: string;
  /** Pixels that differ from the other environment, as counted by the caller. */
  readonly differingPixels: number;
  readonly totalPixels: number;
}

export interface NoisePolicy {
  /**
   * Share of pixels allowed to differ before it counts as a difference.
   *
   * Not zero, ever. Two machines rendering identical HTML disagree on
   * anti-aliased text, and a threshold of zero makes every run red — which is
   * the same as having no check at all, only noisier.
   */
  readonly maxDiffPixelRatio: number;
  /** Regions excluded by name — clocks, relative timestamps, anything live. */
  readonly maskedRegions: readonly string[];
  /** Whether animations were frozen before capture. */
  readonly animationsDisabled: boolean;
}

export const DEFAULT_NOISE_POLICY: NoisePolicy = {
  maxDiffPixelRatio: 0.01,
  maskedRegions: [],
  animationsDisabled: true,
};

export const COMPARISON_VERDICTS = ['match', 'differs', 'unusable'] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

export interface Comparison {
  readonly page: string;
  readonly left: string;
  readonly right: string;
  readonly ratio: number | null;
  readonly verdict: ComparisonVerdict;
  readonly because: string;
}

/**
 * Compare one page across two environments.
 *
 * `unusable` is a third verdict rather than a failure, and it is the one that
 * keeps this honest. A comparison run without a noise policy, or against a
 * screenshot of zero size, has not found a difference — it has failed to look.
 * Reporting that as `differs` would train people to ignore the whole report;
 * reporting it as `match` would be a lie.
 */
export function compareEnvironments(
  left: EnvironmentShot,
  right: EnvironmentShot,
  policy: NoisePolicy = DEFAULT_NOISE_POLICY,
): Comparison {
  const base = { page: left.page, left: left.environment, right: right.environment };

  if (left.page !== right.page) {
    return {
      ...base,
      ratio: null,
      verdict: 'unusable',
      because: `comparing ${left.page} against ${right.page} — different pages`,
    };
  }

  if (left.totalPixels <= 0 || right.totalPixels <= 0) {
    return { ...base, ratio: null, verdict: 'unusable', because: 'a capture was empty' };
  }

  if (left.totalPixels !== right.totalPixels) {
    // Different viewport or a page that grew: a ratio computed across
    // mismatched canvases is arithmetic, not a comparison.
    return {
      ...base,
      ratio: null,
      verdict: 'unusable',
      because:
        `captures are different sizes (${String(left.totalPixels)} vs ${String(right.totalPixels)} px) — ` +
        'compare at a fixed viewport, or the number means nothing',
    };
  }

  if (!policy.animationsDisabled) {
    return {
      ...base,
      ratio: null,
      verdict: 'unusable',
      because:
        'animations were not frozen before capture, so any difference found is as likely to be ' +
        'a frame boundary as an environment',
    };
  }

  const ratio = Math.max(left.differingPixels, right.differingPixels) / left.totalPixels;

  if (ratio <= policy.maxDiffPixelRatio) {
    return {
      ...base,
      ratio,
      verdict: 'match',
      because: `${(ratio * 100).toFixed(3)}% of pixels differ, within the ${(policy.maxDiffPixelRatio * 100).toFixed(2)}% noise allowance`,
    };
  }

  return {
    ...base,
    ratio,
    verdict: 'differs',
    because:
      `${(ratio * 100).toFixed(3)}% of pixels differ, above the ${(policy.maxDiffPixelRatio * 100).toFixed(2)}% allowance. ` +
      'Same commit, different render — look for fonts, missing assets, locale or timezone',
  };
}

export interface EnvironmentReport {
  readonly comparisons: readonly Comparison[];
  readonly differing: number;
  readonly unusable: number;
  readonly matched: number;
}

export function compareAll(
  pairs: readonly (readonly [EnvironmentShot, EnvironmentShot])[],
  policy: NoisePolicy = DEFAULT_NOISE_POLICY,
): EnvironmentReport {
  const comparisons = pairs.map(([left, right]) => compareEnvironments(left, right, policy));
  return {
    comparisons,
    differing: comparisons.filter((entry) => entry.verdict === 'differs').length,
    unusable: comparisons.filter((entry) => entry.verdict === 'unusable').length,
    matched: comparisons.filter((entry) => entry.verdict === 'match').length,
  };
}

export function formatEnvironmentReport(report: EnvironmentReport): string {
  const lines = [
    `${String(report.matched)} matched, ${String(report.differing)} differ, ` +
      `${String(report.unusable)} unusable`,
  ];
  for (const comparison of report.comparisons) {
    const mark =
      comparison.verdict === 'match' ? '✓' : comparison.verdict === 'differs' ? '✗' : '·';
    lines.push(
      `  ${mark} ${comparison.page} (${comparison.left} vs ${comparison.right}) — ${comparison.because}`,
    );
  }
  if (report.unusable > 0) {
    // Called out separately, because an unusable comparison is not a pass and
    // a summary line that only counts failures reads as if it were.
    lines.push('', 'An unusable comparison has not found a difference — it has failed to look.');
  }
  return lines.join('\n');
}

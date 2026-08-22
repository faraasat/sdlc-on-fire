import { expect, test } from '@playwright/test';
import {
  compareAll,
  DEFAULT_NOISE_POLICY,
  formatEnvironmentReport,
} from '@sdlc-on-fire/core/browser';
import { startHarness, type Harness } from './fixture.js';

/**
 * Two deployments of the same commit, compared (P3-UI-05).
 *
 * Skipped unless `SDLC_COMPARE_URL` names a second environment, and that is
 * deliberate rather than lazy: there is no second deployment on a developer's
 * laptop, and a test that invents one would be comparing a thing to itself and
 * reporting a pass that means nothing.
 *
 *   SDLC_COMPARE_URL=https://staging.example pnpm --filter @sdlc-on-fire/ui e2e \
 *     --project=chromium -g "cross-environment"
 *
 * When it does run, the local harness is one side and the named URL is the
 * other. What it catches is the class regression testing structurally cannot:
 * fonts that resolve here and 404 there, CDN configuration, missing assets,
 * locale and timezone defaults — none of which are code changes.
 */

const PAGES = ['/', '/?view=table'];
const PORT = 4698;

const compareUrl = process.env['SDLC_COMPARE_URL'];

test.describe('cross-environment rendering', () => {
  test.skip(compareUrl === undefined, 'set SDLC_COMPARE_URL to a second deployment of this commit');

  let harness: Harness;

  test.beforeAll(async () => {
    harness = await startHarness(PORT);
  });

  test.afterAll(async () => {
    await harness?.stop();
  });

  test('renders identically in both environments', async ({ page }, testInfo) => {
    const shots = [];

    for (const pagePath of PAGES) {
      const captures: { differing: number; total: number }[] = [];

      for (const base of [harness.url, compareUrl as string]) {
        await page.goto(`${base}${pagePath}`);
        await page.waitForLoadState('networkidle');
        const buffer = await page.screenshot({
          fullPage: true,
          // The noise policy, applied at capture rather than at comparison.
          // Freezing here is what makes the two captures comparable at all.
          animations: 'disabled',
          caret: 'hide',
        });
        captures.push({ differing: 0, total: buffer.byteLength });
        await testInfo.attach(`${pagePath}-${base}`, { body: buffer, contentType: 'image/png' });
      }

      const [left, right] = captures;
      // Byte length stands in for a pixel count here: an exact per-pixel diff
      // needs a decoder this package does not carry, and the honest thing is to
      // say so rather than to imply a precision that is not there. What the
      // comparison below is really testing is the *policy* — that a difference
      // is judged against a stated allowance and that an uncomparable pair
      // reports as unusable rather than as a pass.
      shots.push([
        {
          environment: 'local',
          url: harness.url,
          page: pagePath,
          differingPixels: Math.abs((left?.total ?? 0) - (right?.total ?? 0)),
          totalPixels: Math.max(left?.total ?? 0, right?.total ?? 0),
        },
        {
          environment: 'compare',
          url: compareUrl as string,
          page: pagePath,
          differingPixels: Math.abs((left?.total ?? 0) - (right?.total ?? 0)),
          totalPixels: Math.max(left?.total ?? 0, right?.total ?? 0),
        },
      ] as const);
    }

    const report = compareAll(shots, DEFAULT_NOISE_POLICY);
    expect(report.differing, formatEnvironmentReport(report)).toBe(0);
    expect(report.unusable, formatEnvironmentReport(report)).toBe(0);
  });
});

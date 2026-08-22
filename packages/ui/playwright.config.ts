import { defineConfig, devices } from '@playwright/test';

/**
 * Cross-browser UI verification (P3-UI-03).
 *
 * Three engines because the claim "it works in a browser" is three different
 * claims. WebKit in particular diverges on focus, scroll anchoring and date
 * rendering in ways Chromium never shows — and a board is exactly the kind of
 * surface (drag, sticky headers, virtualized columns) where those diverge.
 *
 * Not part of `pnpm check`. These need browser binaries, a built board and a
 * running daemon; folding them into the per-commit suite would make every
 * commit depend on a ~400MB download. Run with `pnpm --filter
 * @sdlc-on-fire/ui e2e` and per release.
 */
export default defineConfig({
  testDir: './e2e',
  // Serial by default: the fixture drives one daemon holding one PGlite, which
  // is single-connection. Parallel workers would contend for the same lock and
  // fail as flakes rather than as findings.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],

  use: {
    baseURL: process.env['SDLC_E2E_URL'] ?? 'http://127.0.0.1:4699',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  /**
   * The noise policy, and it is the whole difference between a visual check
   * that gets read and one that is switched off within a week. Pixel diffing
   * has been solved for years; what fails is anti-aliasing, animation, and
   * clock-dependent rendering producing a diff on every single run.
   *
   * `animations: 'disabled'` freezes CSS animations and transitions — this UI
   * has a pulsing live-run chip and Recharts' entry animation, both of which
   * would otherwise differ between any two captures of an identical page.
   * `maxDiffPixelRatio` absorbs sub-pixel text rendering rather than demanding
   * bit-equality that no two machines produce.
   */
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      maxDiffPixelRatio: 0.01,
    },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // The responsiveness matrix. A board that only works at 1280px is a board
    // that does not work on the laptop half the team actually uses.
    { name: 'mobile', use: { ...devices['iPhone 14'] } },
    { name: 'tablet', use: { ...devices['iPad Mini'] } },
  ],
});

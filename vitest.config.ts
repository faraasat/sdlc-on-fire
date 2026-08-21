import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One root Vitest run over every package. Cross-package imports are aliased to
// source rather than to each package's `exports` → `dist`, so tests (and watch
// mode) run without a build step. Type resolution takes the other route: project
// references against the built .d.ts (tsconfig.base.json).
export default defineConfig({
  resolve: {
    alias: {
      '@sdlc-on-fire/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@sdlc-on-fire/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@sdlc-on-fire/storage': fileURLToPath(
        new URL('./packages/storage/src/index.ts', import.meta.url),
      ),
      '@sdlc-on-fire/agent-manager': fileURLToPath(
        new URL('./packages/agent-manager/src/index.ts', import.meta.url),
      ),
      '@sdlc-on-fire/context': fileURLToPath(
        new URL('./packages/context/src/index.ts', import.meta.url),
      ),
      '@sdlc-on-fire/evidence': fileURLToPath(
        new URL('./packages/evidence/src/index.ts', import.meta.url),
      ),
      '@sdlc-on-fire/daemon': fileURLToPath(
        new URL('./packages/daemon/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    // Windows gets a longer default. Not because its tests are flaky — because
    // process creation there costs roughly an order of magnitude more than on
    // Linux, and the integration suites spawn `git` several times per case. The
    // failures this replaces were wall-clock, with the assertions never
    // reached. The value is still a timeout and still fails a genuine hang; it
    // is sized for the platform rather than for the fastest one.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,

    // The hook budget was left at Vitest's 10s default while `testTimeout` was
    // raised, and that asymmetry is what actually went red on Windows CI: a
    // `beforeEach` that scaffolds a workspace, or an `afterEach` that removes
    // one containing a PGlite data directory, does not fit in ten seconds
    // there — file deletion is slow and the EBUSY retry loop adds to it.
    //
    // The tell was that the failure named a *passing* test ("lets the body be
    // edited without touching the effect") and reported `Hook timed out in
    // 10000ms`: nothing was wrong with the assertion, the fixture never
    // finished. A per-file `beforeEach(..., 60_000)` did not help, because the
    // teardown alongside it carried no timeout at all and inherited the
    // default. Sized for the platform, for the same reason as above.
    hookTimeout: process.platform === 'win32' ? 60_000 : 10_000,

    // `scripts/` is included deliberately. The release guard lives there
    // rather than in a package — it is repo tooling, not shipped code — and a
    // glob covering only `packages/` meant its test file was collected by
    // nothing and reported by nothing. A test that silently never runs is worse
    // than no test, because the file's presence reads as coverage.
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});

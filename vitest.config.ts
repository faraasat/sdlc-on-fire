import { defineConfig } from 'vitest/config';

// One root Vitest run over every package. Cross-package imports are aliased to
// source rather than to each package's `exports` → `dist`, so tests (and watch
// mode) run without a build step. Type resolution takes the other route: project
// references against the built .d.ts (tsconfig.base.json).
export default defineConfig({
  resolve: {
    alias: {
      '@sdlc-on-fire/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@sdlc-on-fire/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@sdlc-on-fire/storage': new URL('./packages/storage/src/index.ts', import.meta.url).pathname,
      '@sdlc-on-fire/agent-manager': new URL(
        './packages/agent-manager/src/index.ts',
        import.meta.url,
      ).pathname,
      '@sdlc-on-fire/context': new URL('./packages/context/src/index.ts', import.meta.url).pathname,
      '@sdlc-on-fire/evidence': new URL('./packages/evidence/src/index.ts', import.meta.url)
        .pathname,
      '@sdlc-on-fire/daemon': new URL('./packages/daemon/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/browser.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false, // tsc emits declarations (see tsconfig.base.json),
  sourcemap: true,
  clean: false, // tsc emits .d.ts into dist first; tsup must not wipe it (use `pnpm clean`),
});

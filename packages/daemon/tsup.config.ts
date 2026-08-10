import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: false, // tsc emits declarations (see tsconfig.base.json),
  sourcemap: true,
  clean: false, // tsc emits .d.ts into dist first; tsup must not wipe it (use `pnpm clean`),
  // tsup externalizes `dependencies` and `peerDependencies` but not
  // `optionalDependencies` — and the ONNX runtime is optional here on purpose
  // (ADR-0033 build-script grant). Bundled, its native `.node` bindings resolve
  // against the bundle instead of the package, and every inference call in the
  // built daemon dies with `listSupportedBackends is not a function` while the
  // source path keeps working. Named explicitly so that stays fixed.
  external: ['@huggingface/transformers', 'onnxruntime-node'],
});

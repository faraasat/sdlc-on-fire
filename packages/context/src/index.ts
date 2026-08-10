export * from './assemble.js';
export * from './metrics.js';
export * from './retrieval.js';
export * from './chunking.js';
export * from './rehydrate.js';

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';

/**
 * Identity of the `@sdlc-on-fire/context` package. Real context behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const contextPackage: PackageInfo = {
  name: '@sdlc-on-fire/context',
  dependsOn: ['@sdlc-on-fire/core'],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const contextDependencies: readonly PackageInfo[] = [corePackage];

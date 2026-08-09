export * from './frontmatter.js';
export * from './typed-file.js';

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';

/**
 * Identity of the `@sdlc-on-fire/storage` package. Real storage behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const storagePackage: PackageInfo = {
  name: '@sdlc-on-fire/storage',
  dependsOn: ['@sdlc-on-fire/core'],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const storageDependencies: readonly PackageInfo[] = [corePackage];

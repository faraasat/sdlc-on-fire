export * from './ir.js';
export * from './port.js';
export * from './writer.js';
export * from './openspec.js';
export * from './speckit.js';
import type { PackageInfo } from '@sdlc-on-fire/core';

/** Identity of the `@sdlc-on-fire/importers` package (P2-IMP-01). */
export const importersPackage: PackageInfo = {
  name: '@sdlc-on-fire/importers',
  dependsOn: ['@sdlc-on-fire/core', '@sdlc-on-fire/storage'],
};

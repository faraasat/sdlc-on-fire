export * from './ir.js';
export * from './port.js';
export * from './writer.js';
export * from './openspec.js';
export * from './speckit.js';
export * from './gsd.js';
export * from './bmad.js';
import type { PackageInfo } from '@sdlc-on-fire/core';

/** Identity of the `@sdlc-on-fire/importers` package (P2-IMP-01). */
export const importersPackage: PackageInfo = {
  name: '@sdlc-on-fire/importers',
  dependsOn: ['@sdlc-on-fire/core', '@sdlc-on-fire/storage'],
};
export * from './export-port.js';
export * from './exporters.js';

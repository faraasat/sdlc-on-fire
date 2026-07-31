import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';
import { dbPackage } from '@sdlc-on-fire/db';
import { storagePackage } from '@sdlc-on-fire/storage';
import { contextPackage } from '@sdlc-on-fire/context';
import { evidencePackage } from '@sdlc-on-fire/evidence';

/**
 * Identity of the `@sdlc-on-fire/daemon` package. Real daemon behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const daemonPackage: PackageInfo = {
  name: '@sdlc-on-fire/daemon',
  dependsOn: [
    '@sdlc-on-fire/core',
    '@sdlc-on-fire/db',
    '@sdlc-on-fire/storage',
    '@sdlc-on-fire/context',
    '@sdlc-on-fire/evidence',
  ],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const daemonDependencies: readonly PackageInfo[] = [
  corePackage,
  dbPackage,
  storagePackage,
  contextPackage,
  evidencePackage,
];

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';
import { dbPackage } from '@sdlc-on-fire/db';
import { storagePackage } from '@sdlc-on-fire/storage';
import { contextPackage } from '@sdlc-on-fire/context';
import { evidencePackage } from '@sdlc-on-fire/evidence';

export * from './sandbox/tiers.js';
export * from './sandbox/exec.js';
export * from './git/naming.js';
export * from './git/git-manager.js';
export * from './sync/self-write-registry.js';
export * from './sync/sync-engine.js';
export * from './sync/rebuild.js';
export * from './sync/git-hooks.js';
export * from './metrics/otel.js';
export * from './scheduler/admission.js';
export * from './scheduler/caps.js';
export * from './lifecycle/engine.js';
export * from './lifecycle/invariants.js';
export * from './pr/generate.js';

/**
 * Identity of the `@sdlc-on-fire/daemon` package. The daemon owns the Git Manager
 * (architecture.md §3) — branches and worktrees are created here, never by hand.
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

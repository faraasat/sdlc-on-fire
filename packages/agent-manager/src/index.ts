export * from './port.js';
export * from './prompt.js';
export * from './adapters/claude-code.js';
export * from './doctor.js';
export * from './skills/canonical.js';
export * from './skills/review.js';
export * from './dispatch.js';

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';

/**
 * Identity of the `@sdlc-on-fire/agent-manager` package. Real agent-manager behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const agentManagerPackage: PackageInfo = {
  name: '@sdlc-on-fire/agent-manager',
  dependsOn: ['@sdlc-on-fire/core'],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const agentManagerDependencies: readonly PackageInfo[] = [corePackage];

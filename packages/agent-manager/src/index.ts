export * from './port.js';
export * from './prompt.js';
export * from './adapters/claude-code.js';
export * from './adapters/mcp.js';
export * from './doctor.js';
export * from './skills/canonical.js';
export * from './skills/review.js';
export * from './skills/retrospective.js';
export * from './dispatch.js';
export * from './skills/output-schemas.js';
export * from './tier-router.js';
export * from './fixtures.js';
export * from './isolation.js';
export * from './handoff.js';
export * from './low-tier-verify.js';
export * from './reconcile.js';
export * from './trajectory-eval.js';

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
export * from './adapters/tool-budget.js';
export * from './adapters/markdown-targets.js';
export * from './skills/planning.js';
export * from './skills/write-tests.js';

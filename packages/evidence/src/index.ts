export * from './parsers.js';
export * from './parse-runners.js';
export * from './code-quality.js';
export * from './knowledge-claim.js';
export * from './definition-of-ready.js';
export * from './traceability.js';
export * from './spec-quality.js';
export * from './doc-freshness.js';
export * from './doc-health.js';
export * from './user-guide.js';
export * from './dependency-audit.js';
export * from './runner.js';
export * from './evaluate-gate.js';
export * from './gate-record.js';
export * from './constitution-compile.js';
export * from './install-gate.js';
export * from './security-gate.js';
export * from './security-review.js';

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';

/**
 * Identity of the `@sdlc-on-fire/evidence` package. Real evidence behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const evidencePackage: PackageInfo = {
  name: '@sdlc-on-fire/evidence',
  dependsOn: ['@sdlc-on-fire/core'],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const evidenceDependencies: readonly PackageInfo[] = [corePackage];

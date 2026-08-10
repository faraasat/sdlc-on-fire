/**
 * `@sdlc-on-fire/core` — the object model.
 *
 * Zod is the single type source (contracts/README.md): every exported TS type
 * here is a `z.infer` of a schema defined once in this package, never a
 * hand-written interface duplicated downstream. `packages/storage`, `db`,
 * `daemon`, and `evidence` all import their shapes from here.
 */

export * from './ids.js';
export * from './lifecycle.js';
export * from './work-item.js';
export * from './constitution.js';
export * from './evidence.js';
export * from './focus.js';
export * from './run.js';
export * from './context.js';
export * from './memory.js';
export * from './memory-entry.js';
export * from './workspace.js';
export * from './storage-port.js';
export * from './capabilities.js';
export * from './idempotency.js';
export * from './skill.js';
export * from './subagent-caps.js';
export * from './tier-policy.js';
export * from './hash.js';
export * from './task-spec.js';
export * from './preset.js';
export * from './docs.js';

/**
 * Package identity, surfaced by `sdlc doctor` so a running install can report
 * exactly which packages it is composed of.
 */
export interface PackageInfo {
  readonly name: string;
  /** Workspace packages this one depends on, by npm name. */
  readonly dependsOn: readonly string[];
}

/**
 * Identity of the `@sdlc-on-fire/core` package. Core sits at the root of the
 * dependency graph and imports no other workspace package — the ports-never-
 * import-adapters discipline (architecture §4a) starts here.
 */
export const corePackage: PackageInfo = {
  name: '@sdlc-on-fire/core',
  dependsOn: [],
};

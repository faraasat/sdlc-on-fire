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
 * Identity of the `@sdlc-on-fire/core` package. Real core behaviour lands in later
 * Phase 0 tasks — this scaffold exists to prove the workspace wiring.
 */
export const corePackage: PackageInfo = {
  name: '@sdlc-on-fire/core',
  dependsOn: [],
};

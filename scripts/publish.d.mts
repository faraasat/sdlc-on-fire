/** Hand-authored types for `publish.mjs` — see `verify-package.d.mts` for why. */

/** The `execFileSync` seam every registry-touching function is injected with. */
type Exec = (file: string, args: string[], options?: Record<string, unknown>) => string;

/** What the registry currently holds for a package: its tags and its versions. */
export interface RegistrySnapshot {
  distTags: Record<string, string>;
  versions: string[];
}

export declare function authCheckMode(
  env?: Record<string, string | undefined>,
): 'oidc-deferred' | 'whoami';
export declare function distTagFor(version: string): 'next' | 'latest';
export declare function publishFlags(env?: Record<string, string | undefined>): {
  provenance: boolean;
  flags: string[];
};
export declare function publishStdio(dryRun: boolean): ('inherit' | 'ignore')[];
export declare function alreadyPublished(name: string, version: string, exec?: Exec): boolean;
export declare function registryTags(name: string, exec?: Exec): RegistrySnapshot | null;
export declare function shouldAdvanceLatest(
  version: string,
  snapshot: RegistrySnapshot | null,
): boolean;
export declare function distTagAddCommand(name: string, version: string): string;
export declare function advanceLatest(
  name: string,
  version: string,
  exec?: Exec,
): { moved: boolean; reason: string | null };

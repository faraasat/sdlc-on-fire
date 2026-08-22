/** Hand-authored types for `publish.mjs` — see `verify-package.d.mts` for why. */
export declare function distTagFor(version: string): 'next' | 'latest';
export declare function publishFlags(env?: Record<string, string | undefined>): {
  provenance: boolean;
  flags: string[];
};
export declare function publishStdio(dryRun: boolean): ('inherit' | 'ignore')[];
export declare function alreadyPublished(
  name: string,
  version: string,
  exec?: (file: string, args: string[], options?: Record<string, unknown>) => string,
): boolean;

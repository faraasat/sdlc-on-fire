/**
 * Types for `verify-package.mjs`.
 *
 * Hand-authored rather than generated, because the script stays plain ESM: CI
 * runs it with `node scripts/verify-package.mjs` before anything is built, and
 * a tool that needs a build to check the build is a tool that cannot run when
 * the build is what broke.
 *
 * Declaring them beats a `@ts-expect-error` at the import. That suppression
 * made the module error-typed, which silently turned every assertion in the
 * test file into an unchecked `any` — coverage that looks like coverage.
 */

export interface TarballFindings {
  readonly name: string;
  readonly version: string;
  readonly findings: readonly string[];
}

export interface VerifyOptions {
  /** The lockstep version this release publishes, when one is known. */
  readonly expectedVersion?: string | undefined;
}

/** Verifies one packed tarball, returning every finding rather than throwing. */
export function verifyTarball(tarball: string, options?: VerifyOptions): TarballFindings;

/** Packs every publishable workspace package and verifies each tarball. */
export function verifyWorkspace(
  options?: VerifyOptions & { readonly cwd?: string | undefined },
): readonly TarballFindings[];

import type { PackageInfo } from '@sdlc-on-fire/core';
import { corePackage } from '@sdlc-on-fire/core';

/**
 * `@sdlc-on-fire/db` — the Postgres adapter.
 *
 * v0.1 ships one provisioning mode: the bundled PGlite fast path. Connected mode
 * (any Postgres-compatible endpoint by connection string — a local install,
 * Docker, Supabase, Neon) lands in `P0-DB-02` and reuses the same capability
 * probe. We ship no database binaries of our own (ADR-0068).
 */

export * from './paths.js';
export * from './pglite.js';
export * from './schema.js';
export * from './migrate.js';
export * from './postgres-adapter.js';

/** Identity of the `@sdlc-on-fire/db` package. */
export const dbPackage: PackageInfo = {
  name: '@sdlc-on-fire/db',
  dependsOn: ['@sdlc-on-fire/core'],
};

/** Resolved dependency identities — proves the workspace links are real, not just declared. */
export const dbDependencies: readonly PackageInfo[] = [corePackage];

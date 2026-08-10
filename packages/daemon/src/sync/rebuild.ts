import type { StoragePort } from '@sdlc-on-fire/core';
import { SyncEngine, type SyncOutcome } from './sync-engine.js';

/**
 * `db:rebuild` — drop the mirror and reconstruct it from git (P0-DB-04).
 *
 * This command is the invariant made executable. "Content in git, state in DB"
 * is only true if the DB can be thrown away and rebuilt from the files, so this
 * is the check that keeps the claim honest — if a rebuild ever loses something,
 * that something was never really in git.
 *
 * It reuses the sync code path rather than reimplementing the walk. A second
 * ingestion path would drift from the first, and then a rebuilt mirror would
 * differ from an incrementally-synced one in ways nobody would notice until the
 * difference mattered.
 */

export interface RebuildResult {
  readonly workItems: number;
  readonly docs: number;
  readonly failed: readonly { readonly relativePath: string; readonly error: string }[];
  readonly durationMs: number;
}

/**
 * Empties the mirror, then re-ingests every managed file.
 *
 * Failures are reported, not thrown: a rebuild that aborts on the first
 * malformed card leaves the mirror empty, which is strictly worse than the
 * state it started from. The caller decides what a partial rebuild means.
 */
export async function rebuildMirror(
  workspaceRoot: string,
  store: StoragePort,
): Promise<RebuildResult> {
  const startedAt = Date.now();

  await store.resetMirror();

  const engine = new SyncEngine({ workspaceRoot, store });
  const outcomes: readonly SyncOutcome[] = await engine.reconcile();

  const upserted = outcomes.filter((outcome) => outcome.action === 'upserted');
  return {
    workItems: upserted.filter((outcome) => outcome.kind === 'work_item').length,
    docs: upserted.filter((outcome) => outcome.kind === 'doc').length,
    failed: outcomes
      .filter((outcome) => outcome.action === 'failed')
      .map((outcome) => ({
        relativePath: outcome.relativePath,
        error: outcome.error ?? 'unknown',
      })),
    durationMs: Date.now() - startedAt,
  };
}

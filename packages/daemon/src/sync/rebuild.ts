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
  /** Work items present in the mirror afterwards — not only the ones that changed. */
  readonly workItems: number;
  readonly docs: number;
  /** How many files actually needed rewriting. Zero is the healthy steady state. */
  readonly changed: number;
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

  // Deliberately *not* `resetMirror()`. Truncating `work_items` destroys the
  // rows that `lifecycle_transitions` references, and that history is not a
  // mirror of anything on disk — it is the record of what actually happened,
  // in the same category as evidence and the audit log. A rebuild that erased
  // it would be laundering, not maintenance.
  //
  // `reconcile()` converges the mirror by upserting what exists and pruning
  // what no longer does, which is the same end state without the collateral
  // damage. Chunks are the one genuinely derived artefact, and `replaceChunks`
  // already rewrites those per source.
  const engine = new SyncEngine({ workspaceRoot, store });
  const outcomes: readonly SyncOutcome[] = await engine.reconcile();

  // Count what is *mirrored*, not what changed. Reporting only upserts made a
  // healthy no-op rebuild say "work items: 0" on a workspace full of them,
  // which reads as data loss.
  const mirrored = outcomes.filter(
    (outcome) => outcome.action === 'upserted' || outcome.action === 'skipped-unchanged',
  );
  return {
    workItems: mirrored.filter((outcome) => outcome.kind === 'work_item').length,
    docs: mirrored.filter((outcome) => outcome.kind === 'doc').length,
    changed: outcomes.filter((outcome) => outcome.action === 'upserted').length,
    failed: outcomes
      .filter((outcome) => outcome.action === 'failed')
      .map((outcome) => ({
        relativePath: outcome.relativePath,
        error: outcome.error ?? 'unknown',
      })),
    durationMs: Date.now() - startedAt,
  };
}

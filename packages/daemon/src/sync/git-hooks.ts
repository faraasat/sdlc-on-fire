import fs from 'node:fs/promises';
import path from 'node:path';
import { isManagedContentPath, type StoragePort } from '@sdlc-on-fire/core';
import { SyncEngine, type SyncOutcome } from './sync-engine.js';

/**
 * Git-hook batch re-sync (P0-SYNC-02).
 *
 * The file watcher sees editor saves. It does **not** reliably see git changing
 * hundreds of files at once — a `checkout`, `merge`, `rebase` or `pull` rewrites
 * the tree faster than a debounced watcher can usefully report, and some
 * backends coalesce or drop events under that load. A branch switch that leaves
 * the mirror describing the old branch is a silent wrong answer, which is the
 * failure class this product exists to remove.
 *
 * So git tells us directly: hooks fire after the operation completes, and we
 * re-sync exactly the paths that changed.
 */

/** Hooks that indicate the working tree may have been rewritten under us. */
export const SYNC_HOOKS = ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite'] as const;

export type SyncHook = (typeof SYNC_HOOKS)[number];

export interface InstallHooksResult {
  readonly installed: readonly string[];
  readonly skipped: readonly { readonly hook: string; readonly reason: string }[];
}

/** The marker that lets us recognise — and safely replace — our own hook. */
const MARKER = '# >>> sdlc-on-fire managed hook >>>';

function hookScript(command: string): string {
  return [
    '#!/bin/sh',
    MARKER,
    '# Re-syncs the DB mirror after git rewrites the working tree.',
    '#',
    '# Failure here must never block the git operation that triggered it:',
    '# a broken mirror is recoverable with `sdlc db:rebuild`; a git hook that',
    '# rejects your merge is not something anyone will thank us for.',
    '#',
    '# Resolution order matters. A globally installed `sdlc` is the common case,',
    '# but a project-local install has no such binary on PATH — and a hook that',
    '# silently does nothing because of that is the worst outcome, since the',
    '# mirror then drifts with no signal at all.',
    'if command -v sdlc >/dev/null 2>&1; then',
    `  ${command} || true`,
    'elif [ -x ./node_modules/.bin/sdlc ]; then',
    `  ./node_modules/.bin/${command} || true`,
    'else',
    `  npx --no-install ${command.replace(/^sdlc\b/, 'sdlc-on-fire')} || true`,
    'fi',
    MARKER.replace('>>>', '<<<'),
    '',
  ].join('\n');
}

/**
 * Installs the re-sync hooks into a repository.
 *
 * A hook we did not write is **never** overwritten — it is reported as skipped.
 * Clobbering someone's existing `post-commit` to install our own would be an
 * unforgivable thing for an `init` to do silently.
 */
export async function installGitHooks(
  repoRoot: string,
  command = 'sdlc sync:batch',
): Promise<InstallHooksResult> {
  const hooksDir = path.join(repoRoot, '.git', 'hooks');
  try {
    await fs.mkdir(hooksDir, { recursive: true });
  } catch {
    return {
      installed: [],
      skipped: SYNC_HOOKS.map((hook) => ({ hook, reason: 'no .git/hooks directory' })),
    };
  }

  const installed: string[] = [];
  const skipped: { hook: string; reason: string }[] = [];

  for (const hook of SYNC_HOOKS) {
    const file = path.join(hooksDir, hook);
    const existing = await fs.readFile(file, 'utf8').catch(() => null);

    if (existing !== null && !existing.includes(MARKER)) {
      skipped.push({ hook, reason: 'a hook already exists and was not written by us' });
      continue;
    }

    await fs.writeFile(file, hookScript(command), { mode: 0o755 });
    installed.push(hook);
  }

  return { installed, skipped };
}

export interface BatchSyncResult {
  readonly considered: number;
  readonly outcomes: readonly SyncOutcome[];
}

/**
 * Re-syncs a specific set of paths, as named by git.
 *
 * Paths outside the managed trees are dropped rather than passed through: a
 * merge touching a thousand source files should cost a thousand cheap string
 * checks, not a thousand file reads.
 *
 * Deleted files are handled by the same call — `syncFile` treats a missing file
 * as a delete, so a merge that removes a card removes its mirror row too.
 */
export async function syncChangedPaths(
  workspaceRoot: string,
  store: StoragePort,
  changedPaths: readonly string[],
): Promise<BatchSyncResult> {
  const managed = changedPaths
    .map((entry) => entry.replace(/\\/g, '/').trim())
    .filter((entry) => entry.length > 0 && isManagedContentPath(entry));

  const engine = new SyncEngine({ workspaceRoot, store });
  const outcomes: SyncOutcome[] = [];

  for (const relative of managed) {
    try {
      outcomes.push(await engine.syncFile(path.join(workspaceRoot, relative)));
    } catch (cause) {
      // One malformed card must not abandon the rest of a merge's worth of work.
      outcomes.push({
        relativePath: relative,
        action: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { considered: managed.length, outcomes };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addedLines,
  checkReintroduction,
  extractEntities,
  formatGuard,
  removedLines,
  type GuardResult,
  type RevertedEntity,
} from '@sdlc-on-fire/core';

/**
 * `sdlc guard` (P2-GIT-01).
 *
 * Reads the repository's own revert history, which is the point: the knowledge
 * that something was removed on purpose already exists in git, and the failure
 * this guards against is nobody consulting it.
 */

const run = promisify(execFile);

export type GitRunner = (args: readonly string[]) => Promise<string>;

const defaultGit =
  (cwd: string): GitRunner =>
  async (args) => {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };

/** How far back to read. A revert from three years ago is usually archaeology. */
export const DEFAULT_HISTORY = 500;

/**
 * Every entity removed by a revert in recent history.
 *
 * Finds reverts by `git log --grep`, which catches the conventional
 * `Revert "..."` subject `git revert` writes by default and the `revert:`
 * prefix Conventional Commits uses. A revert committed with neither is
 * invisible here — stated rather than hidden, since the alternative is
 * inferring intent from diffs, which would flag ordinary deletions as reverts.
 */
export async function revertedEntities(
  git: GitRunner,
  limit = DEFAULT_HISTORY,
): Promise<readonly RevertedEntity[]> {
  const log = await git([
    'log',
    `-${String(limit)}`,
    '--grep=^Revert ',
    '--grep=^revert:',
    '--regexp-ignore-case',
    '--format=%H%x00%s',
  ]).catch(() => '');

  const entities: RevertedEntity[] = [];
  for (const line of log.split('\n').filter((l) => l.trim() !== '')) {
    const [sha, subject] = line.split('\0');
    if (sha === undefined || subject === undefined) continue;

    const diff = await git(['show', '--format=', '--unified=0', '--no-color', sha]).catch(() => '');
    // A revert removes what the original added, so the removed side is what
    // this commit took back out of the tree.
    for (const name of extractEntities(removedLines(diff))) {
      entities.push({ name, revertSha: sha, subject });
    }
  }
  return entities;
}

export interface GuardCheckResult {
  readonly base: string;
  readonly revertsScanned: number;
  readonly guard: GuardResult;
}

export async function checkGuard(
  root: string,
  options: {
    readonly base?: string | undefined;
    readonly git?: GitRunner | undefined;
    readonly message?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): Promise<GuardCheckResult> {
  const base = options.base ?? 'HEAD';
  const git = options.git ?? defaultGit(root);

  const reverted = await revertedEntities(git, options.limit ?? DEFAULT_HISTORY);
  const diff = await git(['diff', '--unified=0', '--no-color', base]).catch(() => '');

  // The message defaults to what is staged for commit, so the acknowledgment
  // trailer works at the moment somebody is actually writing it.
  const message =
    options.message ?? (await git(['log', '-1', '--format=%B']).catch(() => '')) ?? '';

  return {
    base,
    revertsScanned: new Set(reverted.map((e) => e.revertSha)).size,
    guard: checkReintroduction(reverted, addedLines(diff), message),
  };
}

export function formatGuardCheck(result: GuardCheckResult): string {
  return [
    `${String(result.revertsScanned)} revert(s) in history compared against changes since ${result.base}`,
    '',
    formatGuard(result.guard),
  ].join('\n');
}

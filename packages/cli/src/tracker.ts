/**
 * `sdlc tracker:sync` — the CLI surface for P5-TRACK-01.
 *
 * **The token is never a flag.** It comes from `SDLCOF_GITHUB_TOKEN`, or from a
 * file named by `SDLCOF_GITHUB_TOKEN_FILE`, and there is deliberately no
 * `--token` option to be helpful with. A credential passed as an argument is
 * visible in `ps` to every other user on the machine and is written verbatim
 * into shell history, where it outlives the command by months. Adding the flag
 * "for convenience" would undo that with one line, so the absence is
 * documented here rather than left to look like an oversight.
 */

import { promises as fs } from 'node:fs';
import {
  createGithubPort,
  describeConflicts,
  runSync,
  type ConflictPolicy,
  type LocalItem,
  type RemoteItem,
  type SyncCursor,
  type SyncReport,
} from '@sdlc-on-fire/core';

export class TokenMissingError extends Error {
  constructor() {
    super(
      'No GitHub token. Set SDLCOF_GITHUB_TOKEN, or SDLCOF_GITHUB_TOKEN_FILE to a path holding it.\n' +
        'There is no --token flag on purpose: command-line arguments are visible to other\n' +
        'users via `ps` and are recorded in shell history.',
    );
    this.name = 'TokenMissingError';
  }
}

/**
 * Resolve the token, preferring the file.
 *
 * A file beats an environment variable when both are present because the file
 * is the more deliberate of the two — an inherited `SDLCOF_GITHUB_TOKEN` from
 * an unrelated shell is exactly the accident that syncs a workspace to the
 * wrong account.
 */
export async function resolveToken(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const file = env['SDLCOF_GITHUB_TOKEN_FILE']?.trim();
  if (file !== undefined && file !== '') {
    const contents = (await fs.readFile(file, 'utf8')).trim();
    if (contents === '') throw new TokenMissingError();
    return contents;
  }
  // Trim and test for emptiness, not just undefined: CI declares the variable
  // and leaves it blank when the secret is unset, and an undefined-only check
  // then authenticates with an empty string and fails as a confusing 401.
  const inline = env['SDLCOF_GITHUB_TOKEN']?.trim();
  if (inline === undefined || inline === '') throw new TokenMissingError();
  return inline;
}

export interface TrackerSyncOptions {
  readonly repo: string;
  readonly locals: readonly LocalItem[];
  readonly cursors: ReadonlyMap<string, SyncCursor>;
  readonly token: string;
  readonly since?: string | undefined;
  readonly policy?: ConflictPolicy | undefined;
  readonly dryRun?: boolean | undefined;
  readonly adopt: (remote: RemoteItem) => Promise<LocalItem>;
}

export async function trackerSync(options: TrackerSyncOptions): Promise<SyncReport> {
  const port = createGithubPort({
    repo: options.repo,
    token: options.token,
    adopt: options.adopt,
  });
  return runSync({
    locals: options.locals,
    port,
    cursors: options.cursors,
    keyFor: ({ local, remote }) =>
      remote !== undefined ? `github:${options.repo}:${remote.id}` : `local:${local?.id ?? '?'}`,
    since: options.since,
    policy: options.policy,
    dryRun: options.dryRun,
  });
}

/** The human-readable run summary. */
export function renderSyncReport(report: SyncReport): string {
  const counts = new Map<string, number>();
  for (const outcome of report.outcomes) {
    counts.set(outcome.decision.action, (counts.get(outcome.decision.action) ?? 0) + 1);
  }
  const lines = [
    report.dryRun
      ? 'Dry run — nothing was written.'
      : `Applied ${String(report.applied)} change(s).`,
    ...[...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `  ${k}: ${String(v)}`),
  ];
  if (report.failures.length > 0) {
    lines.push('', `${String(report.failures.length)} item(s) failed:`);
    for (const failure of report.failures)
      lines.push(`  ${failure.key} — ${failure.failure ?? ''}`);
  }
  if (report.conflicts.length > 0) lines.push('', describeConflicts(report));
  return lines.join('\n');
}

/**
 * The process exit code.
 *
 * Non-zero whenever anything was left unresolved, so a scheduled sync that
 * quietly stops converging shows up as a failing job rather than as a green
 * one with a paragraph nobody reads.
 */
export function exitCodeFor(report: SyncReport): number {
  return report.ok ? 0 : 1;
}

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { relativePosix, resolveWorkspaceLayout, ROOT_FILES } from '@sdlc-on-fire/core';
import { createGitManager } from '@sdlc-on-fire/daemon';

/**
 * `sdlc backup` — an archive of the things that cannot be rebuilt
 * (P6-SURFACE-07, FEAT-STORE-013).
 *
 * **What it deliberately leaves out is the interesting half.** The PGlite
 * mirror is excluded by default, and not to save space: including it by default
 * would quietly teach people that the database is worth preserving, which is
 * the exact belief the *content in git, state in DB* invariant exists to
 * prevent. Everything in the mirror is reconstructable with `db:rebuild` from
 * the files that *are* in the archive. `--include-mirror` is there for the
 * person who wants a byte-for-byte snapshot anyway, and the manifest records
 * which choice was made.
 *
 * **What it includes that git does not.** Context packs under `.sdlc/` are the
 * record of what an agent was actually asked, they are written once, and they
 * are not tracked — so a repository clone is not a backup of them.
 *
 * `tar` rather than a bundled archiver: the format has to be readable in ten
 * years by somebody who does not have this tool, and `tar -xzf` is that. It
 * also means there is no `sdlc restore` — a bespoke restore command for a
 * standard archive would be a second thing to trust for no gain.
 */

const run = promisify(execFile);

/** Trees worth preserving, in the order they go into the archive. */
export const BACKUP_ROOTS = ['kanban', 'docs', '.sdlc'] as const;

/** Where backups land by default — inside the gitignored state dir. */
export const BACKUP_DIR = 'backups';

/** The manifest's file name inside the archive, wherever the state dir is. */
const MANIFEST_NAME = 'backup-manifest.json';

export interface BackupManifest {
  readonly tool: string;
  readonly createdAt: string;
  readonly gitSha: string;
  readonly included: readonly string[];
  /** What was left out, each with the reason. */
  readonly excluded: readonly { readonly path: string; readonly why: string }[];
  readonly includesMirror: boolean;
}

export interface BackupResult {
  readonly archivePath: string;
  readonly manifest: BackupManifest;
  /** Entries `tar -t` reports in the archive that was written. */
  readonly entryCount: number;
  readonly bytes: number;
  readonly sha256: string;
  /** Roots that were asked for and are not in this workspace. */
  readonly missing: readonly string[];
}

export interface BackupOptions {
  readonly out?: string | undefined;
  readonly includeMirror?: boolean | undefined;
  readonly now?: Date | undefined;
}

/** `2026-08-30T02-04-51Z` — sortable, and legal on every filesystem. */
export function archiveStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function backupWorkspace(
  root: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const layout = resolveWorkspaceLayout(root);
  const now = options.now ?? new Date();
  const stateDirName = path.basename(layout.stateDir);

  const git = createGitManager({ repoRoot: layout.root });
  const gitSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);

  const wanted = [
    ...BACKUP_ROOTS,
    ...ROOT_FILES,
    ...(options.includeMirror === true ? [stateDirName] : []),
  ];
  const included: string[] = [];
  const missing: string[] = [];
  for (const entry of wanted) {
    if (await exists(path.join(layout.root, entry))) included.push(entry);
    else missing.push(entry);
  }

  const excluded: BackupManifest['excluded'] = [
    ...(options.includeMirror === true
      ? []
      : [
          {
            path: `${stateDirName}/`,
            why: 'the mirror is state, not content — `sdlc db:rebuild` reconstructs it from what is in this archive',
          },
        ]),
    {
      path: `${stateDirName}/${BACKUP_DIR}/`,
      why: 'previous backups — an archive that contains its own predecessors doubles on every run',
    },
  ];

  const manifest: BackupManifest = {
    tool: 'sdlc backup',
    createdAt: now.toISOString(),
    gitSha,
    included,
    excluded,
    includesMirror: options.includeMirror === true,
  };

  const outDir = options.out ?? path.join(layout.stateDir, BACKUP_DIR);
  await fs.mkdir(outDir, { recursive: true });
  const archivePath = path.join(outDir, `sdlcof-${gitSha.slice(0, 8)}-${archiveStamp(now)}.tar.gz`);

  // The manifest is staged inside the workspace so it lands *in* the archive at
  // a predictable path. A manifest sitting beside the archive is the first
  // thing to get separated from it.
  const manifestPath = path.join(layout.stateDir, MANIFEST_NAME);
  await fs.mkdir(layout.stateDir, { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  try {
    await run(
      'tar',
      [
        '-czf',
        archivePath,
        '-C',
        layout.root,
        `--exclude=${stateDirName}/${BACKUP_DIR}`,
        relativePosix(layout.root, manifestPath),
        ...included,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await fs.rm(manifestPath, { force: true });
  }

  // Verified by reading the archive back, not by trusting tar's exit code.
  // "The command returned 0" is the self-report this repository does not accept
  // anywhere else, and a truncated archive is exactly the failure a backup
  // must not report as a success.
  const { stdout } = await run('tar', ['-tzf', archivePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const entryCount = stdout.split('\n').filter((line) => line.trim() !== '').length;

  const bytes = (await fs.stat(archivePath)).size;
  const sha256 = createHash('sha256')
    .update(await fs.readFile(archivePath))
    .digest('hex');

  return { archivePath, manifest, entryCount, bytes, sha256, missing };
}

/**
 * Reads an archive back and returns its manifest — the check that it is restorable.
 *
 * **Members are located by listing, not by a glob.** `tar --include=<pattern>`
 * is libarchive's; GNU tar has no such option and fails the whole invocation on
 * it. That difference is invisible on macOS (whose `tar` *is* bsdtar) and turns
 * every Linux read into "this archive has no manifest" — a platform
 * incompatibility wearing the costume of an ordinary negative result, which is
 * exactly what a swallowed error buys you. So: list the entries, match the
 * name here, and extract that one member by its exact stored path, which both
 * tars accept.
 *
 * The two failure modes stay distinguishable. An archive that cannot be listed
 * **throws** — an unreadable backup is a different fact from a backup with no
 * manifest, and reporting the first as the second is how a corrupt archive gets
 * filed as a minor omission.
 */
export async function readBackupManifest(archivePath: string): Promise<BackupManifest | null> {
  const listed = await run('tar', ['-tzf', archivePath], { maxBuffer: 64 * 1024 * 1024 });
  const member = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && path.posix.basename(line) === MANIFEST_NAME);
  if (member === undefined) return null;

  const { stdout } = await run('tar', ['-xzOf', archivePath, member], {
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout) as BackupManifest;
  } catch {
    return null;
  }
}

export function formatBackup(result: BackupResult): string {
  const lines = [
    `wrote ${result.archivePath}`,
    `  ${String(result.entryCount)} entries · ${(result.bytes / 1024).toFixed(1)} KiB · sha256 ${result.sha256.slice(0, 16)}…`,
    `  bound to commit ${result.manifest.gitSha.slice(0, 8)}`,
    '',
    'included:',
    ...result.manifest.included.map((entry) => `  ${entry}`),
    '',
    'left out:',
    ...result.manifest.excluded.map((entry) => `  ${entry.path} — ${entry.why}`),
  ];
  if (result.missing.length > 0) {
    lines.push('', `not present in this workspace: ${result.missing.join(', ')}`);
  }
  lines.push('', `restore with: tar -xzf ${path.basename(result.archivePath)} -C <target>`);
  return lines.join('\n');
}

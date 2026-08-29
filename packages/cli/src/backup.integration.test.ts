import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveStamp,
  backupWorkspace,
  formatBackup,
  readBackupManifest,
  BACKUP_DIR,
} from './backup.js';
import { init } from './commands.js';

/**
 * `sdlc backup` against a real workspace and real tar (P6-SURFACE-07).
 *
 * The claim that matters is not "an archive was written" — it is that the
 * archive can be unpacked into a workspace `db:rebuild` could run against, and
 * that the database was left out on purpose rather than forgotten.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const run = promisify(execFile);
let root: string;

async function entries(archive: string): Promise<string[]> {
  const { stdout } = await run('tar', ['-tzf', archive], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-')));
  await run('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'chore: init'], { cwd: root });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('what goes in', () => {
  it('carries the content trees and the context packs', async () => {
    const packDir = path.join(root, '.sdlc', 'context', 'packs');
    await fs.mkdir(packDir, { recursive: true });
    await fs.writeFile(path.join(packDir, 'run-1.md'), 'what we asked for', 'utf8');

    const result = await backupWorkspace(root);
    const listed = await entries(result.archivePath);

    expect(listed.some((e) => e.includes('kanban/'))).toBe(true);
    expect(listed.some((e) => e.includes('docs/'))).toBe(true);
    // The packs are the reason a git clone is not a backup: written once, and
    // not tracked.
    expect(listed.some((e) => e.endsWith('.sdlc/context/packs/run-1.md'))).toBe(true);
    expect(listed.some((e) => e.endsWith('AGENTS.md'))).toBe(true);
  }, 180_000);

  it('leaves the mirror out by default, and says why', async () => {
    const result = await backupWorkspace(root);
    const listed = await entries(result.archivePath);

    expect(listed.some((e) => e.includes('.sdlcof/db'))).toBe(false);
    expect(result.manifest.includesMirror).toBe(false);
    expect(result.manifest.excluded.map((e) => e.why).join(' ')).toContain('db:rebuild');
  }, 180_000);

  it('includes the mirror when asked', async () => {
    const result = await backupWorkspace(root, { includeMirror: true });
    expect(result.manifest.includesMirror).toBe(true);
    expect(result.manifest.included).toContain('.sdlcof');
  }, 180_000);

  it('never contains a previous backup, even when the mirror is included', async () => {
    // `--include-mirror` is the case that matters: the backups live *inside*
    // the state dir, so without the exclude every archive would contain all its
    // predecessors and each one would be larger than the last.
    await backupWorkspace(root, { includeMirror: true });
    const second = await backupWorkspace(root, {
      includeMirror: true,
      now: new Date(Date.parse('2030-01-01')),
    });
    const listed = await entries(second.archivePath);
    expect(listed.some((e) => e.includes(`${BACKUP_DIR}/`))).toBe(false);
    // And the state dir really was in there — otherwise this proves nothing.
    expect(listed.some((e) => e.includes('.sdlcof/'))).toBe(true);
  }, 180_000);
});

describe('the archive itself', () => {
  it('is restorable into an empty directory', async () => {
    await fs.writeFile(path.join(root, 'kanban', 'marker.md'), 'restored', 'utf8');
    const result = await backupWorkspace(root);

    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-'));
    try {
      await run('tar', ['-xzf', result.archivePath, '-C', target]);
      expect(await fs.readFile(path.join(target, 'kanban', 'marker.md'), 'utf8')).toBe('restored');
    } finally {
      await fs.rm(target, { recursive: true, force: true, ...RM_RETRY });
    }
  }, 180_000);

  it('counts its entries by reading the archive back, not by trusting tar exit 0', async () => {
    const result = await backupWorkspace(root);
    expect(result.entryCount).toBe((await entries(result.archivePath)).length);
    expect(result.entryCount).toBeGreaterThan(1);
  }, 180_000);

  it('carries a manifest inside itself, bound to the commit', async () => {
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    const result = await backupWorkspace(root);

    const manifest = await readBackupManifest(result.archivePath);
    expect(manifest?.gitSha).toBe(head);
    // Inside, not beside: a manifest next to the archive is the first thing to
    // get separated from it.
    expect(manifest?.included).toContain('kanban');
  }, 180_000);

  it('leaves no manifest behind in the workspace', async () => {
    const result = await backupWorkspace(root);
    expect(result.archivePath).toContain(BACKUP_DIR);
    await expect(fs.stat(path.join(root, '.sdlcof', 'backup-manifest.json'))).rejects.toThrow();
  }, 180_000);

  it('reports a sha256 of what was actually written', async () => {
    const result = await backupWorkspace(root);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toBeGreaterThan(0);
  }, 180_000);
});

describe('names and reporting', () => {
  it('stamps a sortable, filesystem-legal name', () => {
    const stamp = archiveStamp(new Date(Date.parse('2026-08-30T02:04:51.123Z')));
    expect(stamp).toBe('2026-08-30T02-04-51Z');
    expect(stamp).not.toContain(':');
  });

  it('names the restore command, since there is no sdlc restore', async () => {
    const text = formatBackup(await backupWorkspace(root));
    expect(text).toContain('tar -xzf');
    expect(text).toContain('left out:');
  }, 180_000);

  it('reports roots that are simply not in this workspace', async () => {
    await fs.rm(path.join(root, 'docs'), { recursive: true, force: true });
    const result = await backupWorkspace(root);
    expect(result.missing).toContain('docs');
    expect(result.manifest.included).not.toContain('docs');
  }, 180_000);
});

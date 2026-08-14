import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { installGitHooks, syncChangedPaths, SYNC_HOOKS } from './git-hooks.js';

/**
 * Git-hook batch re-sync (P0-SYNC-02), against a real git repository.
 *
 * The watcher cannot be trusted to see a merge or a branch switch, so the whole
 * point of this path is that git reports the change directly. Faking git here
 * would test the fake.
 */

const run = promisify(execFile);

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let root: string;

const card = (id: string, title: string): string =>
  `---\nid: ${id}\nkind: task\ntitle: ${title}\nstatus: To Do\n` +
  `lifecycle_state: implement\nwork_type: task\npreset: standard\n---\n\nbody\n`;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-hooks-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test'], { cwd: root });

  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);

  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('installing the hooks', () => {
  it('writes an executable hook for every git operation that rewrites the tree', async () => {
    const result = await installGitHooks(root);
    expect([...result.installed].sort()).toEqual([...SYNC_HOOKS].sort());

    for (const hook of SYNC_HOOKS) {
      const file = path.join(root, '.git', 'hooks', hook);
      const stat = await fs.stat(file);
      // Git silently ignores a hook that is not executable — a hook installed
      // without the bit set is worse than none, because it looks installed.
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('never blocks the git operation that triggered it', async () => {
    // A broken mirror is recoverable with db:rebuild; a hook that rejects a
    // merge is not something anyone will forgive.
    const script = await fs.readFile(path.join(root, '.git', 'hooks', 'post-merge'), 'utf8');
    expect(script).toContain('|| true');
  });

  it('is idempotent — reinstalling replaces our own hook', async () => {
    const again = await installGitHooks(root);
    expect(again.installed).toContain('post-commit');
    expect(again.skipped).toEqual([]);
  });

  it('refuses to clobber a hook someone else wrote', async () => {
    const file = path.join(root, '.git', 'hooks', 'post-commit');
    await fs.writeFile(file, '#!/bin/sh\necho "the user own hook"\n', { mode: 0o755 });

    const result = await installGitHooks(root);
    expect(result.installed).not.toContain('post-commit');
    expect(result.skipped.map((entry) => entry.hook)).toContain('post-commit');
    // And it is still theirs.
    expect(await fs.readFile(file, 'utf8')).toContain('the user own hook');
  });
});

describe('batch syncing what git reports', () => {
  it('mirrors the paths a commit touched', async () => {
    const relative = 'kanban/_inbox/TASK-100.md';
    await fs.writeFile(path.join(root, relative), card('TASK-100', 'From a commit'), 'utf8');
    await run('git', ['add', '-A'], { cwd: root });
    await run('git', ['commit', '-qm', 'add card'], { cwd: root });

    // Exactly what a post-commit hook would hand us. `--root` matters: without
    // it a root commit reports no paths at all, so the very first commit in a
    // fresh repo would sync nothing.
    const { stdout } = await run(
      'git',
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', 'HEAD'],
      { cwd: root },
    );

    const result = await syncChangedPaths(root, port, stdout.split('\n'));
    expect(result.outcomes.some((o) => o.action === 'upserted')).toBe(true);
    expect(await port.stageOf('TASK-100')).not.toBeNull();
  });

  it('ignores paths outside the managed trees', async () => {
    // A merge touching a thousand source files should cost a thousand string
    // checks, not a thousand file reads.
    const result = await syncChangedPaths(root, port, [
      'src/index.ts',
      'README.md',
      'package.json',
    ]);
    expect(result.considered).toBe(0);
    expect(result.outcomes).toEqual([]);
  });

  it('removes the mirror row when a merge deletes a card', async () => {
    const relative = 'kanban/_inbox/TASK-100.md';
    await fs.rm(path.join(root, relative));

    const result = await syncChangedPaths(root, port, [relative]);
    expect(result.outcomes[0]?.action).toBe('deleted');
    expect(await port.stageOf('TASK-100')).toBeNull();
  });

  it('reports one bad card without abandoning the rest of the batch', async () => {
    await fs.writeFile(
      path.join(root, 'kanban', '_inbox', 'TASK-BAD.md'),
      `---\nkind: task\ntitle: no id\n---\n\nbody\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'kanban', '_inbox', 'TASK-101.md'),
      card('TASK-101', 'Good one'),
      'utf8',
    );

    const result = await syncChangedPaths(root, port, [
      'kanban/_inbox/TASK-BAD.md',
      'kanban/_inbox/TASK-101.md',
    ]);

    expect(result.outcomes.filter((o) => o.action === 'failed')).toHaveLength(1);
    expect(await port.stageOf('TASK-101')).not.toBeNull();
  });

  it('tolerates the blank line git leaves at the end of its output', async () => {
    const result = await syncChangedPaths(root, port, ['', '   ', 'kanban/_inbox/TASK-101.md']);
    expect(result.considered).toBe(1);
  });
});

describe('how the hook finds the CLI', () => {
  it('falls back when sdlc is not on PATH, rather than silently doing nothing', async () => {
    // A project-local install has no global `sdlc`. A hook that quietly no-ops
    // is the worst outcome: the mirror drifts with no signal at all.
    await fs.rm(path.join(root, '.git', 'hooks', 'post-commit')).catch(() => undefined);
    await installGitHooks(root);
    const script = await fs.readFile(path.join(root, '.git', 'hooks', 'post-commit'), 'utf8');

    expect(script).toContain('command -v sdlc');
    expect(script).toContain('./node_modules/.bin/');
    expect(script).toContain('npx --no-install');
    // And the fallback is quiet: before the package is installed anywhere, npx
    // prints a registry error, and nobody should see npm output on every commit
    // for a sync they never asked for.
    expect(script).toMatch(/npx --no-install .*>\/dev\/null 2>&1/);
  });
});

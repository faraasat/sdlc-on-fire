import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitManager,
  NotARepositoryError,
  NothingToCommitError,
  parseWorktreePorcelain,
  type GitManager,
} from './git-manager.js';

/**
 * These tests drive real `git` against real temporary repositories. Mocking
 * simple-git would only prove the mock matches our expectations of git, which is
 * exactly the assumption most likely to be wrong.
 */

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  // macOS /tmp is a symlink to /private/tmp; git reports the resolved path, so
  // resolving here keeps path assertions comparable.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function newRepo(): Promise<{ root: string; git: GitManager }> {
  const root = await tempDir('sdlcof-git-');
  const raw = simpleGit(root);
  await raw.init(['--initial-branch=main']);
  await raw.addConfig('user.email', 'test@example.com');
  await raw.addConfig('user.name', 'Test');
  await raw.addConfig('commit.gpgsign', 'false');

  await fs.writeFile(path.join(root, 'README.md'), '# test\n');
  await raw.add(['README.md']);
  await raw.commit('chore: init');

  return { root, git: createGitManager({ repoRoot: root }) };
}

async function write(root: string, relative: string, contents: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('repository detection', () => {
  it('recognises a real repository', async () => {
    const { git } = await newRepo();
    await expect(git.isRepo()).resolves.toBe(true);
  });

  it('reports a non-repository rather than failing obscurely later', async () => {
    const dir = await tempDir('sdlcof-plain-');
    const git = createGitManager({ repoRoot: dir });
    await expect(git.isRepo()).resolves.toBe(false);
    await expect(git.currentBranch()).rejects.toBeInstanceOf(NotARepositoryError);
  });
});

describe('branches', () => {
  it('reports the current branch', async () => {
    const { git } = await newRepo();
    await expect(git.currentBranch()).resolves.toBe('main');
  });

  it('creates and checks out a branch', async () => {
    const { git } = await newRepo();
    await git.createBranch('feat/auth-login-P1-GATE-02-evaluategate');

    await expect(git.currentBranch()).resolves.toBe('feat/auth-login-P1-GATE-02-evaluategate');
    await expect(git.listBranches()).resolves.toContain('feat/auth-login-P1-GATE-02-evaluategate');
  });

  it('branches from an explicit start point', async () => {
    const { root, git } = await newRepo();
    await git.createBranch('feat/one');
    await write(root, 'a.txt', 'a');
    await git.commit('feat: a', ['a.txt']);

    await git.createBranch('feat/two', 'main');
    // Started from main, so the commit made on feat/one is not present.
    await expect(fs.stat(path.join(root, 'a.txt'))).rejects.toThrow();
  });
});

describe('working-tree classification', () => {
  it('sees untracked and modified paths alike', async () => {
    const { root, git } = await newRepo();
    await write(root, 'kanban/tasks/TASK-001.md', 'x');
    await write(root, 'README.md', '# changed\n');

    await expect(git.changedPaths()).resolves.toEqual(['README.md', 'kanban/tasks/TASK-001.md']);
  });

  it('splits bookkeeping from product code', async () => {
    const { root, git } = await newRepo();
    await write(root, 'kanban/tasks/TASK-001.md', 'x');
    await write(root, 'src/index.ts', 'export {};');

    const changes = await git.classifyWorkingTree();
    expect(changes.managed).toEqual(['kanban/tasks/TASK-001.md']);
    expect(changes.product).toEqual(['src/index.ts']);
  });
});

describe('commit', () => {
  it('commits only the paths it was given', async () => {
    const { root, git } = await newRepo();
    await write(root, 'a.txt', 'a');
    await write(root, 'b.txt', 'b');

    await git.commit('feat: only a', ['a.txt']);

    // b.txt is still uncommitted, so it remains in the change set.
    await expect(git.changedPaths()).resolves.toEqual(['b.txt']);
  });

  it('adds the bookkeeping trailer for a managed-only change', async () => {
    const { root, git } = await newRepo();
    await write(root, 'kanban/tasks/TASK-001.md', 'status: review');

    const result = await git.commit('chore(sdlc): mark TASK-001 in_review', [
      'kanban/tasks/TASK-001.md',
    ]);
    expect(result.bookkeeping).toBe(true);

    const message = await simpleGit(root).raw(['log', '-1', '--pretty=%B']);
    expect(message).toContain('Sdlc-Bookkeeping: true');
  });

  it('does not add the trailer when product code is included', async () => {
    const { root, git } = await newRepo();
    await write(root, 'kanban/tasks/TASK-001.md', 'x');
    await write(root, 'src/index.ts', 'export {};');

    const result = await git.commit('feat: real work', [
      'kanban/tasks/TASK-001.md',
      'src/index.ts',
    ]);
    expect(result.bookkeeping).toBe(false);

    const message = await simpleGit(root).raw(['log', '-1', '--pretty=%B']);
    expect(message).not.toContain('Sdlc-Bookkeeping');
  });

  it('returns the sha and branch it committed onto', async () => {
    const { root, git } = await newRepo();
    await git.createBranch('feat/x');
    await write(root, 'a.txt', 'a');

    const result = await git.commit('feat: a', ['a.txt']);
    expect(result.branch).toBe('feat/x');
    expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('refuses an empty path list rather than making an empty commit', async () => {
    const { git } = await newRepo();
    await expect(git.commit('nothing', [])).rejects.toBeInstanceOf(NothingToCommitError);
  });
});

describe('diff', () => {
  it('returns nothing for a clean tree', async () => {
    const { git } = await newRepo();
    await expect(git.diff()).resolves.toBe('');
  });

  it('shows a tracked modification', async () => {
    const { root, git } = await newRepo();
    await write(root, 'README.md', '# changed\n');

    const diff = await git.diff();
    expect(diff).toContain('README.md');
    expect(diff).toContain('+# changed');
  });

  it('scopes to the requested paths', async () => {
    const { root, git } = await newRepo();
    await write(root, 'README.md', '# changed\n');
    await write(root, 'other.txt', 'x');
    await simpleGit(root).add(['other.txt']);

    const diff = await git.diff(['other.txt']);
    expect(diff).not.toContain('README.md');
  });
});

describe('worktrees', () => {
  it('adds, lists, and removes a worktree', async () => {
    const { root, git } = await newRepo();
    // A worktree must live outside its repo, so it is tracked for cleanup
    // separately — otherwise a failing assertion leaks a directory in /tmp.
    const worktreePath = path.join(root, '..', `wt-${path.basename(root)}`);
    tempDirs.push(worktreePath);

    await git.addWorktree(worktreePath, 'feat/wave-1');
    const listed = await git.listWorktrees();

    expect(listed.map((w) => w.branch)).toContain('feat/wave-1');
    await expect(fs.stat(path.join(worktreePath, 'README.md'))).resolves.toBeDefined();

    await git.removeWorktree(worktreePath, { force: true });
    expect((await git.listWorktrees()).map((w) => w.branch)).not.toContain('feat/wave-1');
  });

  it('always lists the main worktree', async () => {
    const { root, git } = await newRepo();
    const listed = await git.listWorktrees();
    expect(listed.some((w) => w.path === root)).toBe(true);
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses multiple entries', () => {
    const output = [
      '/repo/main',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      '/repo/wt',
      'HEAD def456',
      'branch refs/heads/feat/x',
      '',
    ]
      .map((line) => (line.startsWith('/') ? `worktree ${line}` : line))
      .join('\n');

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: '/repo/main', head: 'abc123', branch: 'main' },
      { path: '/repo/wt', head: 'def456', branch: 'feat/x' },
    ]);
  });

  it('represents a detached HEAD as a null branch', () => {
    const output = 'worktree /repo/wt\nHEAD abc123\ndetached\n';
    expect(parseWorktreePorcelain(output)).toEqual([
      { path: '/repo/wt', head: 'abc123', branch: null },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

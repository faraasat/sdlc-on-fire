import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { toPosixPath } from '@sdlc-on-fire/core';
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
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

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
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
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
    // Both sides through `realpath` and posix. `os.tmpdir()` on a Windows
    // runner is the 8.3 short form (`C:\\Users\\RUNNER~1\\…`) while git reports
    // the long one, so comparing the string this test happens to hold against
    // the string git happens to print compares two spellings of one directory.
    const expected = toPosixPath(await fs.realpath(root));
    expect(listed.some((w) => toPosixPath(w.path) === expected)).toBe(true);
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

describe('provenance and squash-and-sign (P1-GIT-01)', () => {
  const PROVENANCE = { tool: 'Claude-Code', model: 'claude-opus-4-5-20260101' };

  it('stamps every commit it makes with the running tool and model', async () => {
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root, provenance: PROVENANCE });

    await fs.writeFile(path.join(root, 'src.ts'), 'export const a = 1;\n');
    await git.commit('feat: add a', ['src.ts']);

    const message = await simpleGit(root).raw(['log', '-1', '--format=%B']);
    expect(message).toContain('Assisted-by: Claude-Code:claude-opus-4-5-20260101');
    // Read back through git's own trailer parser, not a substring match: the
    // point of the trailer is that git can query it, and a line git does not
    // recognise as a trailer is just prose that happens to contain a colon.
    const trailers = await simpleGit(root).raw([
      'log',
      '-1',
      '--format=%(trailers:key=Assisted-by,valueonly)',
    ]);
    expect(trailers.trim()).toBe('Claude-Code:claude-opus-4-5-20260101');
  });

  it('keeps the bookkeeping trailer queryable alongside provenance', async () => {
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root, provenance: PROVENANCE });

    await fs.mkdir(path.join(root, 'kanban'), { recursive: true });
    await fs.writeFile(path.join(root, 'kanban', 'TASK-001.md'), 'card\n');
    const result = await git.commit('chore: card', ['kanban/TASK-001.md']);
    expect(result.bookkeeping).toBe(true);

    const both = await simpleGit(root).raw([
      'log',
      '-1',
      '--format=%(trailers:key=Sdlc-Bookkeeping,valueonly)%(trailers:key=Assisted-by,valueonly)',
    ]);
    expect(both).toContain('true');
    expect(both).toContain('Claude-Code:claude-opus-4-5-20260101');
  });

  it('collapses a branch’s noisy intermediates into one commit with the same tree', async () => {
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root, provenance: PROVENANCE });
    const raw = simpleGit(root);

    await git.createBranch('feat/TASK-001-thing');
    for (const [file, body] of [
      ['a.ts', 'export const a = 1;\n'],
      ['b.ts', 'export const b = 2;\n'],
      ['a.ts', 'export const a = 11;\n'],
    ] as const) {
      await fs.writeFile(path.join(root, file), body);
      await git.commit(`wip: ${file}`, [file]);
    }
    const treeBefore = (await raw.raw(['rev-parse', 'HEAD^{tree}'])).trim();

    const result = await git.squashAndSign({
      baseRef: 'main',
      message: 'feat(TASK-001): the thing',
    });

    // Same content, one commit. A squash that changed the tree would be a
    // rewrite, not a normalisation.
    expect((await raw.raw(['rev-parse', 'HEAD^{tree}'])).trim()).toBe(treeBefore);
    const count = (await raw.raw(['rev-list', '--count', 'main..HEAD'])).trim();
    expect(count).toBe('1');
    expect(result.branch).toBe('feat/TASK-001-thing');
    expect([...result.changes.product].sort()).toEqual(['a.ts', 'b.ts']);

    const message = await raw.raw(['log', '-1', '--format=%B']);
    expect(message).toContain('feat(TASK-001): the thing');
    expect(message).toContain('Assisted-by: Claude-Code:claude-opus-4-5-20260101');
    expect(message).not.toContain('wip:');
  }, 60_000);

  it('refuses to squash the base branch itself', async () => {
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root, provenance: PROVENANCE });

    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await git.commit('feat: a', ['a.ts']);

    // ADR-0013: a correction is a new commit, never a rewrite of shared history.
    await expect(git.squashAndSign({ baseRef: 'main', message: 'feat: x' })).rejects.toThrow(
      /refusing to squash "main"/,
    );
  });

  it('refuses when the branch changed nothing', async () => {
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root, provenance: PROVENANCE });
    await git.createBranch('feat/TASK-002-empty');

    await expect(
      git.squashAndSign({ baseRef: 'main', message: 'feat: nothing' }),
    ).rejects.toBeInstanceOf(NothingToCommitError);
  });

  it('leaves commits unattributed when no provenance is configured', async () => {
    // Absent attribution is honest; a default tool name would be a fabrication.
    const { root } = await newRepo();
    const git = createGitManager({ repoRoot: root });
    await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await git.commit('feat: a', ['a.ts']);

    const message = await simpleGit(root).raw(['log', '-1', '--format=%B']);
    expect(message).not.toContain('Assisted-by');
  });
});

import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  classifyChanges,
  DEFAULT_MANAGED_PREFIXES,
  isBookkeepingOnly,
  withBookkeepingTrailer,
  type ClassifiedChanges,
} from './naming.js';

/**
 * Git Manager — the daemon's git primitives (architecture.md §3).
 *
 * Branches and worktrees are created by this module, never by hand
 * (conventions.md): a hand-named branch loses the traceability the naming scheme
 * exists to provide, and a hand-made worktree escapes the file-ownership checks
 * that keep parallel waves from colliding.
 *
 * Scope here is P0-GIT-01's basics — branch, worktree, commit, diff, and the
 * bookkeeping/product split. Hook wiring for batch re-sync is `P0-SYNC-02`.
 */

export class NotARepositoryError extends Error {
  override readonly name = 'NotARepositoryError';
  constructor(readonly repoRoot: string) {
    super(`${repoRoot} is not inside a git repository`);
  }
}

export class NothingToCommitError extends Error {
  override readonly name = 'NothingToCommitError';
  constructor() {
    super('no paths were staged, so there is nothing to commit');
  }
}

export interface Worktree {
  readonly path: string;
  readonly head: string;
  /** Branch checked out in this worktree, or `null` for a detached HEAD. */
  readonly branch: string | null;
}

export interface CommitResult {
  readonly sha: string;
  readonly branch: string;
  /** Whether the trailer was applied because the change set was bookkeeping-only. */
  readonly bookkeeping: boolean;
  readonly changes: ClassifiedChanges;
}

export interface GitManagerOptions {
  readonly repoRoot: string;
  /** Workspace prefixes treated as tool-managed. Defaults to the contracts/06 set. */
  readonly managedPrefixes?: readonly string[] | undefined;
}

export interface GitManager {
  readonly repoRoot: string;
  isRepo(): Promise<boolean>;
  currentBranch(): Promise<string>;
  listBranches(): Promise<string[]>;
  /** Creates a branch and checks it out. */
  createBranch(name: string, startPoint?: string): Promise<void>;
  /** Paths changed relative to HEAD, including untracked files. */
  changedPaths(): Promise<string[]>;
  /** Changed paths split into tool-managed bookkeeping and product code. */
  classifyWorkingTree(): Promise<ClassifiedChanges>;
  diff(paths?: readonly string[]): Promise<string>;
  /**
   * Stages exactly `paths` and commits them. The bookkeeping trailer is applied
   * automatically when the set touches only managed paths.
   */
  commit(message: string, paths: readonly string[]): Promise<CommitResult>;
  addWorktree(worktreePath: string, branch: string, startPoint?: string): Promise<void>;
  listWorktrees(): Promise<Worktree[]>;
  removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void>;
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * The porcelain form is used rather than the human-readable one specifically
 * because it is a stable contract: the aligned-columns output changes with path
 * lengths and would make this parser position-dependent.
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: { path?: string; head?: string; branch: string | null } | null = null;

  const flush = (): void => {
    if (current?.path !== undefined) {
      worktrees.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch,
      });
    }
    current = null;
  };

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
      continue;
    }
    if (trimmed.startsWith('worktree ')) {
      flush();
      current = { path: trimmed.slice('worktree '.length), branch: null };
    } else if (trimmed.startsWith('HEAD ') && current) {
      current.head = trimmed.slice('HEAD '.length);
    } else if (trimmed.startsWith('branch ') && current) {
      // `refs/heads/feat/x` → `feat/x`
      current.branch = trimmed.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  flush();

  return worktrees;
}

export function createGitManager(options: GitManagerOptions): GitManager {
  const repoRoot = path.resolve(options.repoRoot);
  const managedPrefixes = options.managedPrefixes ?? DEFAULT_MANAGED_PREFIXES;
  const git: SimpleGit = simpleGit(repoRoot);

  async function assertRepo(): Promise<void> {
    if (!(await git.checkIsRepo())) throw new NotARepositoryError(repoRoot);
  }

  async function changedPaths(): Promise<string[]> {
    await assertRepo();
    const status = await git.status();
    // `status.files` already unions staged, unstaged, and untracked entries.
    // Deduped because a path staged *and* further modified appears in both.
    return [...new Set(status.files.map((file) => file.path))].sort();
  }

  return {
    repoRoot,

    async isRepo(): Promise<boolean> {
      return git.checkIsRepo();
    },

    async currentBranch(): Promise<string> {
      await assertRepo();
      const summary = await git.branchLocal();
      return summary.current;
    },

    async listBranches(): Promise<string[]> {
      await assertRepo();
      const summary = await git.branchLocal();
      return [...summary.all].sort();
    },

    async createBranch(name: string, startPoint?: string): Promise<void> {
      await assertRepo();
      if (startPoint === undefined) {
        await git.checkoutLocalBranch(name);
      } else {
        await git.checkoutBranch(name, startPoint);
      }
    },

    changedPaths,

    async classifyWorkingTree(): Promise<ClassifiedChanges> {
      return classifyChanges(await changedPaths(), managedPrefixes);
    },

    async diff(paths?: readonly string[]): Promise<string> {
      await assertRepo();
      // `HEAD --` diffs tracked changes whether or not they are staged, which is
      // what a reviewer means by "the diff" mid-task.
      const args = ['HEAD', '--', ...(paths ?? [])];
      return git.diff(args);
    },

    async commit(message: string, paths: readonly string[]): Promise<CommitResult> {
      await assertRepo();
      if (paths.length === 0) throw new NothingToCommitError();

      const changes = classifyChanges(paths, managedPrefixes);
      const bookkeeping = isBookkeepingOnly(paths, managedPrefixes);
      const finalMessage = bookkeeping ? withBookkeepingTrailer(message) : message.trimEnd();

      await git.add([...paths]);
      const result = await git.commit(finalMessage, [...paths]);
      const summary = await git.branchLocal();

      return {
        sha: result.commit,
        branch: summary.current,
        bookkeeping,
        changes,
      };
    },

    async addWorktree(worktreePath: string, branch: string, startPoint?: string): Promise<void> {
      await assertRepo();
      const args = ['worktree', 'add', '-b', branch, path.resolve(worktreePath)];
      if (startPoint !== undefined) args.push(startPoint);
      await git.raw(args);
    },

    async listWorktrees(): Promise<Worktree[]> {
      await assertRepo();
      return parseWorktreePorcelain(await git.raw(['worktree', 'list', '--porcelain']));
    },

    async removeWorktree(worktreePath: string, opts?: { force?: boolean }): Promise<void> {
      await assertRepo();
      const args = ['worktree', 'remove'];
      if (opts?.force === true) args.push('--force');
      args.push(path.resolve(worktreePath));
      await git.raw(args);
    },
  };
}

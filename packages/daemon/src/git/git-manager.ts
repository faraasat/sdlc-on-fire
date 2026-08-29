import path from 'node:path';
import { toPosixPath } from '@sdlc-on-fire/core';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  classifyChanges,
  DEFAULT_MANAGED_PREFIXES,
  assistedByTrailer,
  BOOKKEEPING_TRAILER,
  isBookkeepingOnly,
  withTrailers,
  type Provenance,
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
  /**
   * Recorded as `Assisted-by:` on every commit this manager makes.
   *
   * Set per-daemon rather than per-call so a commit path that forgets to pass it
   * cannot silently produce an unattributed commit — the attribution is a
   * property of *who is running*, not of the individual commit.
   */
  readonly provenance?: Provenance | undefined;
}

/** Options for {@link GitManager.squashAndSign}. */
export interface SquashOptions {
  /** The branch this work started from — everything after it is collapsed. */
  readonly baseRef: string;
  readonly message: string;
  /**
   * Sign the resulting commit (`git commit -S`).
   *
   * Off by default. Signing needs a key this process may not have, and a commit
   * that silently failed to sign while the caller believed it was signed is
   * worse than one honestly unsigned.
   */
  readonly sign?: boolean | undefined;
}

export class ProtectedBranchError extends Error {
  constructor(branch: string) {
    super(
      `refusing to squash "${branch}" — it is the base branch, and rewriting shared history ` +
        'is not a normalisation step (ADR-0013: a correction is a new commit, never a rewrite).',
    );
    this.name = 'ProtectedBranchError';
  }
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
  /**
   * Modified *tracked* paths only, staged or not.
   *
   * The distinction is about what is at risk from a given operation, not about
   * tidiness. `git checkout` leaves untracked files where they are; `worktree
   * remove` deletes them with the directory. A check that treated the two the
   * same would either block a safe checkout or wave through a destructive
   * removal.
   */
  trackedChanges(): Promise<string[]>;
  /**
   * Paths a single commit touched — what a post-commit/post-merge hook needs.
   *
   * Distinct from {@link changedPaths}, which reports the *working tree*. After
   * a merge the working tree is clean, so asking it what changed answers
   * "nothing" while several hundred files have in fact moved.
   */
  changedInCommit(ref?: string): Promise<string[]>;
  /**
   * The commit evidence is bound to.
   *
   * Returns 40 zeroes on a repo with no commits yet. A sentinel rather than a
   * throw, because "no commits" is a normal state for a workspace someone just
   * initialised, and evidence produced there is simply always stale — which is
   * the correct outcome, not an error.
   */
  headSha(): Promise<string>;
  /** Changed paths split into tool-managed bookkeeping and product code. */
  classifyWorkingTree(): Promise<ClassifiedChanges>;
  diff(paths?: readonly string[]): Promise<string>;
  /**
   * Stages exactly `paths` and commits them. The bookkeeping trailer is applied
   * automatically when the set touches only managed paths.
   */
  commit(message: string, paths: readonly string[]): Promise<CommitResult>;
  /**
   * Collapses this branch's commits since `baseRef` into one signed commit.
   *
   * The `git-sign` pattern (techniques/27 §2.3): an agent's branch accumulates
   * noisy intermediates ("fix lint", "update test") that carry no information a
   * reviewer wants, and as of 2026 no major coding agent can sign its own
   * commits, so agent-authored work lands "Unverified" by default. Squashing to
   * a single commit under a key this process actually holds fixes both at once.
   *
   * This rewrites only the *unmerged* branch, never shared history — squashing
   * the base branch is refused outright.
   */
  squashAndSign(options: SquashOptions): Promise<CommitResult>;
  addWorktree(worktreePath: string, branch: string, startPoint?: string): Promise<void>;
  listWorktrees(): Promise<Worktree[]>;
  removeWorktree(worktreePath: string, options?: { force?: boolean }): Promise<void>;

  /* ---- rollback primitives (P6-SURFACE-06) ---- */

  /**
   * Deletes a branch. Unforced, git refuses one whose commits the base cannot
   * reach — a refusal worth keeping, since the caller is meant to have written
   * a recovery ref first.
   */
  deleteBranch(name: string, options?: { force?: boolean }): Promise<void>;
  /**
   * Points `ref` at `sha`, creating it if absent.
   *
   * Used for `refs/sdlcof/abandoned/*`: a real ref, not a reflog entry, because
   * git expires unreachable reflog entries after 30 days by default.
   */
  writeRef(ref: string, sha: string): Promise<void>;
  /** Whether a ref exists, and what it points at. */
  resolveRef(ref: string): Promise<string | null>;
  /**
   * Moves HEAD to `ref`, detaching when `ref` is a commit rather than a branch.
   *
   * Distinct from {@link createBranch}, which makes a new one. This is for
   * getting *off* a branch — the step before deleting it.
   */
  checkout(ref: string, options?: { force?: boolean }): Promise<void>;
  /** How many commits `ref` has that `base` cannot reach. */
  commitsAhead(ref: string, base: string): Promise<number>;
  /**
   * Commits on `ref` whose message matches `grep`, newest first.
   *
   * Fixed-string matching, not regex: work-item ids contain `-` and callers
   * pass them verbatim.
   */
  searchLog(options: {
    readonly ref?: string | undefined;
    readonly grep: string;
    readonly limit?: number | undefined;
  }): Promise<{ readonly sha: string; readonly subject: string }[]>;
  /**
   * Reverts a commit, committing the inverse.
   *
   * `mainline` is required for a merge commit and meaningless for any other, so
   * it is the caller's to decide — git cannot guess which parent the caller
   * considers the trunk.
   */
  revert(sha: string, options?: { mainline?: number }): Promise<CommitResult>;
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
        // Posix, and said out loud rather than left to git. Git already reports
        // `C:/Users/…` on Windows while a caller's own `path.join` produces
        // `C:\\Users\\…`, so the two never compare equal and the main worktree
        // reads as absent from its own list. Normalising here makes the shape a
        // property of this function instead of a property of the platform.
        path: toPosixPath(current.path),
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

  /**
   * Assembles the message's trailer block.
   *
   * Both trailers go in one block. Git only reads trailers from the last
   * paragraph, so a second paragraph would make the first unqueryable — the
   * failure would be silent and would only surface much later, when someone
   * asked the log a question it could no longer answer.
   */
  function applyTrailers(message: string, bookkeeping: boolean): string {
    const additions: string[] = [];
    if (bookkeeping) additions.push(BOOKKEEPING_TRAILER);
    if (options.provenance !== undefined) additions.push(assistedByTrailer(options.provenance));
    return withTrailers(message, additions);
  }

  async function changedPaths(): Promise<string[]> {
    await assertRepo();
    const status = await git.status();
    // `status.files` already unions staged, unstaged, and untracked entries.
    // Deduped because a path staged *and* further modified appears in both.
    return [...new Set(status.files.map((file) => file.path))].sort();
  }

  async function trackedChanges(): Promise<string[]> {
    await assertRepo();
    const output = await git.raw(['diff', '--name-only', 'HEAD']);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .sort();
  }

  async function changedInCommit(ref = 'HEAD'): Promise<string[]> {
    await assertRepo();
    // `--root` is load-bearing: without it a commit with no parent reports no
    // paths at all, so the very first commit in a fresh repo would sync nothing.
    const output = await git.raw([
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      '--root',
      ref,
    ]);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async function headSha(): Promise<string> {
    await assertRepo();
    try {
      return (await git.revparse(['HEAD'])).trim();
    } catch {
      return '0'.repeat(40);
    }
  }

  return {
    repoRoot,
    changedInCommit,
    headSha,

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
    trackedChanges,

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
      const finalMessage = applyTrailers(message, bookkeeping);

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

    async squashAndSign(opts: SquashOptions): Promise<CommitResult> {
      await assertRepo();
      const summary = await git.branchLocal();
      const branch = summary.current;
      if (branch === opts.baseRef) throw new ProtectedBranchError(branch);

      // What lands is the *net* change against the base, not a replay of the
      // intermediate commits. `reset --soft` moves the branch pointer back while
      // leaving the tree exactly as the work left it, so the single commit that
      // follows has the same content the branch had — no rebase, no conflict
      // resolution, nothing for an agent to get wrong mid-way.
      const paths = await git.raw(['diff', '--name-only', `${opts.baseRef}...HEAD`]);
      const changed = paths
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (changed.length === 0) throw new NothingToCommitError();

      await git.raw(['reset', '--soft', opts.baseRef]);

      const bookkeeping = isBookkeepingOnly(changed, managedPrefixes);
      const message = applyTrailers(opts.message, bookkeeping);
      const args = ['commit', '-m', message];
      if (opts.sign === true) args.push('-S');
      await git.raw(args);

      return {
        sha: (await git.revparse(['HEAD'])).trim(),
        branch,
        bookkeeping,
        changes: classifyChanges(changed, managedPrefixes),
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

    async deleteBranch(name: string, opts?: { force?: boolean }): Promise<void> {
      await assertRepo();
      await git.raw(['branch', opts?.force === true ? '-D' : '-d', name]);
    },

    async writeRef(ref: string, sha: string): Promise<void> {
      await assertRepo();
      await git.raw(['update-ref', ref, sha]);
    },

    async checkout(ref: string, opts?: { force?: boolean }): Promise<void> {
      await assertRepo();
      const args = ['checkout'];
      if (opts?.force === true) args.push('--force');
      // A sha would otherwise be an ambiguous argument; `--detach` says which
      // of the two readings is meant instead of letting git guess from shape.
      if (/^[0-9a-f]{7,40}$/i.test(ref)) args.push('--detach');
      args.push(ref);
      await git.raw(args);
    },

    async resolveRef(ref: string): Promise<string | null> {
      await assertRepo();
      try {
        return (await git.revparse([ref])).trim();
      } catch {
        return null;
      }
    },

    async commitsAhead(ref: string, base: string): Promise<number> {
      await assertRepo();
      // `base..ref` is "reachable from ref, not from base" — the commits that
      // would become unreachable if ref were deleted right now.
      const output = await git.raw(['rev-list', '--count', `${base}..${ref}`]);
      const count = Number.parseInt(output.trim(), 10);
      return Number.isNaN(count) ? 0 : count;
    },

    async searchLog(opts: {
      ref?: string | undefined;
      grep: string;
      limit?: number | undefined;
    }): Promise<{ sha: string; subject: string }[]> {
      await assertRepo();
      const args = [
        'log',
        `-${String(opts.limit ?? 200)}`,
        '--fixed-strings',
        `--grep=${opts.grep}`,
        '--format=%H%x00%s',
      ];
      if (opts.ref !== undefined) args.push(opts.ref);
      const output = await git.raw(args).catch(() => '');

      const commits: { sha: string; subject: string }[] = [];
      for (const line of output.split('\n')) {
        if (line.trim() === '') continue;
        const [sha, subject] = line.split('\0');
        if (sha === undefined || subject === undefined) continue;
        commits.push({ sha, subject });
      }
      return commits;
    },

    async revert(sha: string, opts?: { mainline?: number }): Promise<CommitResult> {
      await assertRepo();
      const args = ['revert', '--no-edit'];
      if (opts?.mainline !== undefined) args.push('-m', String(opts.mainline));
      args.push(sha);
      await git.raw(args);

      const head = (await git.revparse(['HEAD'])).trim();
      const changed = await changedInCommit(head);
      const summary = await git.branchLocal();
      return {
        sha: head,
        branch: summary.current,
        bookkeeping: isBookkeepingOnly(changed, managedPrefixes),
        changes: classifyChanges(changed, managedPrefixes),
      };
    },
  };
}

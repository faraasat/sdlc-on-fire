import {
  formatRollbackPlan,
  planRollback,
  resolveWorkspaceLayout,
  type RollbackPlan,
  type RollbackStep,
  type RollbackSubject,
} from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { createGitManager, type GitManager } from '@sdlc-on-fire/daemon';
import { branchFor } from './branch.js';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc rollback` — the safe way off a work item (P6-SURFACE-06, FEAT-GIT-007).
 *
 * The half that already existed refused *bad* reverts: `revert-guard.ts` warns
 * when a change re-adds what a past revert removed. Nothing performed a good
 * one, so abandoning an agent's bad run meant hand git surgery — `worktree
 * remove --force`, `branch -D`, and a claim left dangling in the mirror because
 * nobody thought to release it.
 *
 * Planning is pure and lives in core ({@link planRollback}); this gathers the
 * facts and executes the steps. The split is not tidiness: the interesting
 * decisions — preserve the tip before deleting, refuse a dirty worktree, revert
 * rather than delete for work that landed — are then testable without a
 * repository, and the integration test can check the far narrower claim that
 * each step does to git what it says it does.
 *
 * Nothing about the *record* is rolled back. See `PRESERVED_BY_ROLLBACK`.
 */

export const DEFAULT_BASE_REF = 'main';

export interface RollbackResult {
  readonly plan: RollbackPlan;
  readonly base: string;
  /** Steps actually executed, in order. Empty for a dry run or a refusal. */
  readonly executed: readonly RollbackStep[];
  /** Where an abandoned branch tip can be recovered from, when one was kept. */
  readonly recoverableFrom?: string | undefined;
  /** The revert commit written, when landed work was reverted. */
  readonly revertSha?: string | undefined;
}

export interface RollbackOptions {
  readonly actor?: string | undefined;
  readonly base?: string | undefined;
  readonly force?: boolean | undefined;
  /** Execute. Absent, this plans and touches nothing. */
  readonly apply?: boolean | undefined;
  /** Injected in tests; defaults to a manager on the workspace root. */
  readonly git?: GitManager | undefined;
}

/**
 * Whether that worktree has anything uncommitted in it.
 *
 * Asked of a manager rooted *at the worktree*, not at the main checkout: `git
 * status` reports the tree it is run in, and running it at the root would
 * answer for the wrong one — cleanly, and wrongly, which is worse than failing.
 */
async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  const inside = createGitManager({ repoRoot: worktreePath });
  return (await inside.changedPaths()).length > 0;
}

/** What the repository and the mirror currently say about this work item. */
export async function inspectForRollback(
  git: GitManager,
  workItemId: string,
  branch: string,
  base: string,
  claimedBy: string | null,
): Promise<RollbackSubject> {
  const branchExists = (await git.listBranches()).includes(branch);
  const tipSha = branchExists ? await git.resolveRef(branch) : null;
  const baseExists = (await git.resolveRef(base)) !== null;

  // With no base to compare against, every commit on the branch counts as
  // unmerged. That is the conservative reading and the right one: it means the
  // tip gets preserved rather than dropped on the strength of a ref that is
  // not there.
  const unmergedCommits = !branchExists ? 0 : baseExists ? await git.commitsAhead(branch, base) : 1;

  // The main checkout is in `listWorktrees()` too, and it is a different case:
  // `worktree remove` refuses to remove it, so being on the branch there is
  // handled by moving HEAD rather than by removing anything.
  const worktree =
    (await git.listWorktrees()).find(
      (candidate) => candidate.branch === branch && candidate.path !== git.repoRoot,
    ) ?? null;

  const checkedOutHere = branchExists && (await git.currentBranch()) === branch;
  // Tracked modifications only. Moving HEAD off the branch leaves untracked
  // files exactly where they are, so counting them would block the rollback on
  // a `.sdlcof/` cache or a scratch file that is in no danger at all — and a
  // safety check that fires on every ordinary working tree gets `--force`d by
  // habit, which is how it stops being a safety check.
  const localDirty = checkedOutHere && (await git.trackedChanges()).length > 0;

  // Work that landed is found by asking the base for a commit that names the
  // item. The limit is worth saying out loud, because it is the same one
  // `revertedEntities` declares: work merged under a message that never names
  // the work item is invisible here, and inferring it from diffs instead would
  // mean guessing.
  const landed = baseExists ? await git.searchLog({ ref: base, grep: workItemId }) : [];

  return {
    workItemId,
    branch,
    branchExists,
    tipSha,
    unmergedCommits,
    landedSha: landed[0]?.sha ?? null,
    worktreePath: worktree === null ? null : worktree.path,
    worktreeDirty: worktree === null ? false : await worktreeIsDirty(worktree.path),
    checkedOutHere,
    localDirty,
    // The base when it exists, else the tip — a detached HEAD at the commit
    // that was about to be abandoned, which is recoverable, rather than a
    // checkout of a ref that is not there.
    leaveTo: baseExists ? base : tipSha,
    claimedBy,
  };
}

async function executeStep(
  git: GitManager,
  step: RollbackStep,
  subject: RollbackSubject,
  port: { releaseClaim(id: string, actor: string): Promise<boolean> },
  state: { recoverableFrom?: string; revertSha?: string },
): Promise<void> {
  switch (step.action) {
    case 'leave-branch':
      await git.checkout(step.target, { force: subject.localDirty });
      break;
    case 'remove-worktree':
      await git.removeWorktree(step.target, { force: subject.worktreeDirty });
      break;
    case 'preserve-tip':
      // `subject.tipSha`, not a fresh read: the plan was made against that tip,
      // and preserving whatever the branch points at *now* would quietly save
      // something the plan never inspected.
      if (subject.tipSha !== null) {
        await git.writeRef(step.target, subject.tipSha);
        state.recoverableFrom = step.target;
      }
      break;
    case 'delete-branch':
      // Forced unconditionally, and only ever after `preserve-tip` has run.
      // Git's own unmerged check is the safety net this replaces with a better
      // one — a ref that does not expire.
      await git.deleteBranch(step.target, { force: true });
      break;
    case 'revert-landed': {
      const result = await git.revert(step.target);
      state.revertSha = result.sha;
      break;
    }
    case 'release-claim':
      await port.releaseClaim(subject.workItemId, step.target);
      break;
  }
}

export async function rollbackWorkItem(
  root: string,
  workItemId: string,
  options: RollbackOptions = {},
): Promise<RollbackResult> {
  const layout = resolveWorkspaceLayout(root);
  const base = options.base ?? DEFAULT_BASE_REF;
  const git = options.git ?? createGitManager({ repoRoot: layout.root });

  const { branch } = await branchFor(root, workItemId);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const held = await port.claimOf(workItemId);

    const subject = await inspectForRollback(
      git,
      workItemId,
      branch,
      base,
      held?.claimedBy ?? null,
    );
    const plan = planRollback(subject, {
      actor: options.actor,
      force: options.force,
    });

    if (!plan.safe || options.apply !== true) {
      return { plan, base, executed: [] };
    }

    const state: { recoverableFrom?: string; revertSha?: string } = {};
    const executed: RollbackStep[] = [];
    for (const step of plan.steps) {
      await executeStep(git, step, subject, port, state);
      executed.push(step);
    }

    // Audited after the fact, on purpose: the entry records what was actually
    // done, and an entry written first would claim a rollback that a mid-way
    // git failure never completed.
    await port.appendAudit({
      action: 'work_item.rollback',
      targetType: 'work_item',
      targetId: workItemId,
      // The actor goes in `detail`, not `actorId`. They are different things:
      // `audit_log.actor_id` is a uuid FK into `actors`, while `--as` is the
      // free-text name a claim is held under (`work_items.claimed_by`). Putting
      // one in the other's column fails at insert time — which is the good case;
      // the bad one is a schema that accepted it and left the chain pointing at
      // an actor that does not exist.
      detail: {
        branch,
        base,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        steps: executed.map((step) => `${step.action} ${step.target}`),
        ...(state.recoverableFrom === undefined ? {} : { recoverableFrom: state.recoverableFrom }),
        ...(state.revertSha === undefined ? {} : { revertSha: state.revertSha }),
      },
    });

    return {
      plan,
      base,
      executed,
      ...(state.recoverableFrom === undefined ? {} : { recoverableFrom: state.recoverableFrom }),
      ...(state.revertSha === undefined ? {} : { revertSha: state.revertSha }),
    };
  } finally {
    await db.close();
  }
}

export function formatRollback(result: RollbackResult): string {
  const lines = [formatRollbackPlan(result.plan)];
  if (!result.plan.safe) return lines.join('\n');

  if (result.executed.length === 0 && result.plan.steps.length > 0) {
    lines.push('', 'dry run — nothing was touched. Re-run with --apply.');
    return lines.join('\n');
  }
  if (result.recoverableFrom !== undefined) {
    lines.push(
      '',
      `recover the abandoned branch with: git checkout -b <name> ${result.recoverableFrom}`,
    );
  }
  if (result.revertSha !== undefined) {
    lines.push('', `reverted in ${result.revertSha.slice(0, 8)}`);
  }
  return lines.join('\n');
}

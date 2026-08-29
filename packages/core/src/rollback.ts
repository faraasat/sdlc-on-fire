/**
 * Work-item rollback (P6-SURFACE-06, FEAT-GIT-007).
 *
 * `revert-guard.ts` prevents a *bad* revert — one that quietly re-adds what a
 * past revert removed. Nothing performed a *good* one. This is the other half:
 * the safe path off a work item whose branch, worktree and claim need to go
 * away.
 *
 * Three rules shape every plan this produces.
 *
 * **1. Rollback abandons the work; it never erases the record of it.** The
 * context packs, the run rows, the evidence envelopes and the audit chain all
 * survive. A rollback that deleted them would make a failed attempt
 * indistinguishable from an attempt that never happened, which is the exact
 * question anybody asks first after a bad agent run.
 *
 * **2. No commit is dropped without a ref holding it.** Deleting an unmerged
 * branch leaves its tip reachable only from the reflog, and git expires
 * unreachable reflog entries after 30 days by default
 * (`gc.reflogExpireUnreachable`, git-gc docs, fetched 2026-08-30). A recovery
 * path with an expiry date is not a recovery path, so the tip is written to
 * `refs/sdlcof/abandoned/<branch>` first.
 *
 * **3. Work that landed is reverted, not deleted.** Once a branch is merged,
 * deleting it changes nothing about the tree — the change is in the base. The
 * undo for that is a revert commit, and the subject it carries is deliberately
 * the one {@link isRevertSubject} recognises, so the guard can see this revert
 * later and ask about anything that re-adds it.
 */

/** How the rollback recovers an abandoned branch tip. */
export const ABANDONED_REF_PREFIX = 'refs/sdlcof/abandoned';

/**
 * Subject prefixes that mark a commit as a revert.
 *
 * One list, used both by the rollback that *writes* a revert and the guard that
 * *finds* one. Two copies would drift into a rollback whose reverts the guard
 * cannot see — a silent hole in exactly the check this pairs with.
 */
export const REVERT_SUBJECT_PREFIXES = ['Revert ', 'revert:'] as const;

/** The subject `git revert --no-edit` writes, said out loud so tests can bind to it. */
export function revertSubject(originalSubject: string): string {
  return `Revert "${originalSubject}"`;
}

export function isRevertSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  return REVERT_SUBJECT_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export function abandonedRef(branch: string): string {
  return `${ABANDONED_REF_PREFIX}/${branch}`;
}

export type RollbackAction =
  | 'remove-worktree'
  | 'leave-branch'
  | 'preserve-tip'
  | 'delete-branch'
  | 'revert-landed'
  | 'release-claim';

export interface RollbackStep {
  readonly action: RollbackAction;
  /** Branch name, worktree path, ref, or sha — whatever the action operates on. */
  readonly target: string;
  readonly why: string;
}

/** What the repository and the mirror currently say about one work item. */
export interface RollbackSubject {
  readonly workItemId: string;
  readonly branch: string;
  readonly branchExists: boolean;
  /** The branch tip, or null when there is no branch. */
  readonly tipSha: string | null;
  /** Commits on the branch that the base cannot reach. */
  readonly unmergedCommits: number;
  /** The commit that brought this branch into the base, when it landed. */
  readonly landedSha: string | null;
  /** A *linked* worktree holding this branch. The main checkout is not one. */
  readonly worktreePath: string | null;
  /** Untracked files or modified tracked files in that worktree. */
  readonly worktreeDirty: boolean;
  /**
   * The branch is what the main checkout has checked out.
   *
   * The common case, not an edge one: `sdlc branch --create` checks the branch
   * out, so the obvious place to run `sdlc rollback` from is standing on it —
   * and git refuses to delete the branch HEAD points at. Without a step to move
   * off it first, the rollback writes the recovery ref and then fails on the
   * delete, which is the one outcome worse than refusing outright.
   */
  readonly checkedOutHere: boolean;
  /** Uncommitted changes in the main checkout. */
  readonly localDirty: boolean;
  /**
   * Where HEAD goes when it has to leave the branch — the base ref when it
   * exists, otherwise the tip, which detaches rather than inventing a
   * destination.
   */
  readonly leaveTo: string | null;
  readonly claimedBy: string | null;
}

export interface RollbackOptions {
  /** Who is rolling back. Must hold the claim when one is held. */
  readonly actor?: string | undefined;
  /** Proceed through a dirty worktree, discarding what is in it. */
  readonly force?: boolean | undefined;
}

export interface RollbackPlan {
  readonly workItemId: string;
  readonly branch: string;
  readonly steps: readonly RollbackStep[];
  /** Why the plan cannot run as asked. Non-empty means nothing should execute. */
  readonly refusals: readonly string[];
  /** What this deliberately leaves alone — stated, so nobody goes looking. */
  readonly preserved: readonly string[];
  readonly safe: boolean;
}

/**
 * Everything a rollback keeps.
 *
 * Listed rather than merely omitted: "the runs are still there" is only
 * reassuring if somebody says so at the moment the work is being thrown away.
 */
export const PRESERVED_BY_ROLLBACK: readonly string[] = [
  'run rows — a run that happened, happened',
  'context packs under .sdlc/ — the evidence of what was actually asked',
  'evidence envelopes — a gate result is a fact about a diff, not about a branch',
  'the audit chain — appended to, never rewritten',
];

/**
 * Plans a rollback. Pure: decides, touches nothing.
 *
 * Step order is a correctness requirement, not presentation. The worktree comes
 * out before the branch because git refuses to delete a branch that is checked
 * out in a worktree, and the claim is released last because an item whose claim
 * is gone while its branch still stands is an item two actors can pick up.
 *
 * A refusal returns before any step is planned, rather than planning steps and
 * discarding them at the end. The difference matters: with the early return,
 * every step below is reached only on a plan that is going to run, so no step
 * needs its own "…but are we allowed to?" guard. Guards like that go stale
 * precisely because nothing can ever reach them to prove they still work.
 */
export function planRollback(
  subject: RollbackSubject,
  options: RollbackOptions = {},
): RollbackPlan {
  const refusals: string[] = [];

  if (subject.claimedBy !== null) {
    if (options.actor === undefined) {
      refusals.push(
        `--as is required: ${subject.workItemId} is claimed by "${subject.claimedBy}", and rolling back someone else's work by accident is the failure this asks about (ADR-0048)`,
      );
    } else if (options.actor !== subject.claimedBy) {
      refusals.push(
        `${subject.workItemId} is claimed by "${subject.claimedBy}", not by "${options.actor}" — ask them, or take the claim first`,
      );
    }
  }

  if (subject.worktreePath !== null && subject.worktreeDirty && options.force !== true) {
    refusals.push(
      `${subject.worktreePath} has uncommitted changes — commit them, or re-run with --force to discard them. Unlike the branch tip, they are not recoverable afterwards.`,
    );
  }

  if (subject.checkedOutHere && subject.localDirty && options.force !== true) {
    refusals.push(
      `${subject.branch} is checked out here and the working tree has uncommitted changes — moving off it would take them along or fail. Commit or stash them, or re-run with --force to discard them.`,
    );
  }

  if (subject.checkedOutHere && subject.leaveTo === null) {
    refusals.push(
      `${subject.branch} is checked out here and there is nowhere to move HEAD to — no base ref and no commit on the branch. Check out another branch first.`,
    );
  }

  if (refusals.length > 0) {
    return {
      workItemId: subject.workItemId,
      branch: subject.branch,
      steps: [],
      refusals,
      preserved: PRESERVED_BY_ROLLBACK,
      safe: false,
    };
  }

  const steps: RollbackStep[] = [];

  if (subject.worktreePath !== null) {
    steps.push({
      action: 'remove-worktree',
      target: subject.worktreePath,
      why: subject.worktreeDirty
        ? 'discarding uncommitted changes, as --force asked'
        : 'clean, so nothing is lost by removing it',
    });
  }

  if (subject.branchExists) {
    // `checkedOutHere` and `worktreePath` are mutually exclusive: git refuses to
    // check the same branch out in two places, so no plan contains both a
    // `remove-worktree` and a `leave-branch`. Their relative order is therefore
    // unobservable, and no test asserts one — said here rather than left as an
    // untested-looking gap.
    if (subject.checkedOutHere && subject.leaveTo !== null) {
      steps.push({
        action: 'leave-branch',
        target: subject.leaveTo,
        why: 'git will not delete the branch HEAD points at',
      });
    }
    if (subject.unmergedCommits > 0 && subject.tipSha !== null) {
      steps.push({
        action: 'preserve-tip',
        target: abandonedRef(subject.branch),
        why: `${String(subject.unmergedCommits)} commit(s) the base cannot reach — the reflog would expire them in 30 days, this ref will not`,
      });
    }
    steps.push({
      action: 'delete-branch',
      target: subject.branch,
      why:
        subject.unmergedCommits > 0
          ? `recoverable from ${abandonedRef(subject.branch)}`
          : 'nothing on it the base does not already have',
    });
  }

  if (subject.landedSha !== null) {
    steps.push({
      action: 'revert-landed',
      target: subject.landedSha,
      why: 'this work is already in the base — deleting the branch would undo nothing, so the undo is a revert commit',
    });
  }

  if (subject.claimedBy !== null) {
    // Unconditional here on purpose: a claim held by anyone but `options.actor`
    // already returned above, so reaching this line *is* the check.
    steps.push({
      action: 'release-claim',
      target: subject.claimedBy,
      why: 'released last, so the item is never claimable while its branch still stands',
    });
  }

  return {
    workItemId: subject.workItemId,
    branch: subject.branch,
    steps,
    refusals,
    preserved: PRESERVED_BY_ROLLBACK,
    safe: true,
  };
}

export function formatRollbackPlan(plan: RollbackPlan): string {
  const lines = [`${plan.workItemId} — rollback of ${plan.branch}`, ''];

  if (plan.refusals.length > 0) {
    lines.push('✗ refused:');
    for (const refusal of plan.refusals) lines.push(`  ${refusal}`);
    return lines.join('\n');
  }

  if (plan.steps.length === 0) {
    lines.push('nothing to roll back — no branch, no worktree, no claim');
    return lines.join('\n');
  }

  for (const step of plan.steps) {
    lines.push(`  ${step.action} ${step.target}`);
    lines.push(`    ${step.why}`);
  }
  lines.push('', 'kept:');
  for (const kept of plan.preserved) lines.push(`  ${kept}`);
  return lines.join('\n');
}

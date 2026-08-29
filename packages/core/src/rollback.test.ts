import { describe, expect, it } from 'vitest';
import {
  abandonedRef,
  formatRollbackPlan,
  isRevertSubject,
  planRollback,
  revertSubject,
  REVERT_SUBJECT_PREFIXES,
  type RollbackSubject,
} from './rollback.js';

const base: RollbackSubject = {
  workItemId: 'TASK-001',
  branch: 'feat/task-001-thing',
  branchExists: true,
  tipSha: 'a'.repeat(40),
  unmergedCommits: 0,
  landedSha: null,
  worktreePath: null,
  worktreeDirty: false,
  checkedOutHere: false,
  localDirty: false,
  leaveTo: 'main',
  claimedBy: null,
};

const actionsOf = (subject: RollbackSubject, options = {}): string[] =>
  planRollback(subject, options).steps.map((step) => step.action);

describe('revert subjects', () => {
  it('writes the subject git revert --no-edit writes', () => {
    expect(revertSubject('feat: add discount')).toBe('Revert "feat: add discount"');
  });

  it('recognises its own output — the guard must be able to find what rollback wrote', () => {
    expect(isRevertSubject(revertSubject('feat: add discount'))).toBe(true);
  });

  it('recognises the conventional-commits form as well', () => {
    expect(isRevertSubject('revert: add discount')).toBe(true);
  });

  it('does not treat an ordinary commit as a revert', () => {
    expect(isRevertSubject('feat: reverting nothing here')).toBe(false);
  });

  it('matches case-insensitively, as the log scan does', () => {
    expect(isRevertSubject('REVERT "x"')).toBe(true);
  });

  it('keeps both prefixes — dropping either blinds the guard to one revert style', () => {
    expect([...REVERT_SUBJECT_PREFIXES]).toEqual(['Revert ', 'revert:']);
  });
});

describe('planRollback', () => {
  it('deletes a merged branch without preserving a tip — the base already has it', () => {
    expect(actionsOf(base)).toEqual(['delete-branch']);
  });

  it('writes an abandoned ref before deleting a branch with unmerged commits', () => {
    const actions = actionsOf({ ...base, unmergedCommits: 3 });
    expect(actions).toEqual(['preserve-tip', 'delete-branch']);
    expect(actions.indexOf('preserve-tip')).toBeLessThan(actions.indexOf('delete-branch'));
  });

  it('names the ref under the sdlcof namespace', () => {
    const [preserve] = planRollback({ ...base, unmergedCommits: 1 }).steps;
    expect(preserve?.target).toBe('refs/sdlcof/abandoned/feat/task-001-thing');
    expect(abandonedRef('x')).toBe('refs/sdlcof/abandoned/x');
  });

  it('does not preserve a tip it does not have', () => {
    expect(actionsOf({ ...base, unmergedCommits: 3, tipSha: null })).toEqual(['delete-branch']);
  });

  it('removes the worktree before deleting the branch — git refuses the other order', () => {
    const actions = actionsOf({ ...base, worktreePath: '/wt/task-001' });
    expect(actions).toEqual(['remove-worktree', 'delete-branch']);
  });

  it('refuses a dirty worktree rather than discarding it', () => {
    const plan = planRollback({ ...base, worktreePath: '/wt/x', worktreeDirty: true });
    expect(plan.safe).toBe(false);
    expect(plan.refusals[0]).toContain('--force');
  });

  it('emits no steps at all when it refuses — a partial rollback is the worst outcome', () => {
    const plan = planRollback({ ...base, worktreePath: '/wt/x', worktreeDirty: true });
    expect(plan.steps).toEqual([]);
  });

  it('discards a dirty worktree under --force, and says that is what it is doing', () => {
    const plan = planRollback(
      { ...base, worktreePath: '/wt/x', worktreeDirty: true },
      { force: true },
    );
    expect(plan.safe).toBe(true);
    expect(plan.steps[0]?.why).toContain('discarding');
  });

  it('reverts landed work instead of pretending a branch deletion undid it', () => {
    const plan = planRollback({ ...base, branchExists: false, landedSha: 'b'.repeat(40) });
    expect(plan.steps.map((s) => s.action)).toEqual(['revert-landed']);
    expect(plan.steps[0]?.target).toBe('b'.repeat(40));
  });

  it('releases the claim last', () => {
    const actions = actionsOf(
      { ...base, unmergedCommits: 2, worktreePath: '/wt/x', claimedBy: 'ada' },
      { actor: 'ada' },
    );
    expect(actions).toEqual(['remove-worktree', 'preserve-tip', 'delete-branch', 'release-claim']);
  });

  it('refuses to roll back work claimed by somebody else', () => {
    const plan = planRollback({ ...base, claimedBy: 'ada' }, { actor: 'grace' });
    expect(plan.safe).toBe(false);
    expect(plan.refusals[0]).toContain('"ada"');
  });

  it('refuses a claimed item when no actor was named', () => {
    const plan = planRollback({ ...base, claimedBy: 'ada' });
    expect(plan.refusals[0]).toContain('--as is required');
  });

  it('does not require an actor for an unclaimed item', () => {
    expect(planRollback(base).safe).toBe(true);
  });

  it('releases the claim even when there is no branch left to delete', () => {
    const plan = planRollback({ ...base, branchExists: false, claimedBy: 'ada' }, { actor: 'ada' });
    expect(plan.steps.map((s) => s.action)).toEqual(['release-claim']);
  });

  it('plans no release for a claim it refused to touch', () => {
    // The release step carries no guard of its own — the refusal above is what
    // stops it. If that ever stops being true, this is the test that says so.
    for (const options of [{}, { actor: 'grace' }]) {
      const plan = planRollback({ ...base, claimedBy: 'ada' }, options);
      expect(plan.steps).toEqual([]);
      expect(plan.safe).toBe(false);
    }
  });

  it('collects every refusal, not just the first', () => {
    const plan = planRollback(
      { ...base, claimedBy: 'ada', worktreePath: '/wt/x', worktreeDirty: true },
      { actor: 'grace' },
    );
    expect(plan.refusals).toHaveLength(2);
  });

  it('plans nothing when there is nothing to roll back', () => {
    const plan = planRollback({ ...base, branchExists: false });
    expect(plan.steps).toEqual([]);
    expect(plan.safe).toBe(true);
  });

  it('always states what it keeps', () => {
    const plan = planRollback(base);
    expect(plan.preserved.join(' ')).toContain('run rows');
    expect(plan.preserved.join(' ')).toContain('audit');
  });
});

describe('the branch you are standing on', () => {
  it('moves HEAD off the branch before deleting it', () => {
    const actions = actionsOf({ ...base, checkedOutHere: true, unmergedCommits: 1 });
    expect(actions).toEqual(['leave-branch', 'preserve-tip', 'delete-branch']);
  });

  it('leaves for the base ref', () => {
    const [leave] = planRollback({ ...base, checkedOutHere: true }).steps;
    expect(leave?.target).toBe('main');
  });

  it('detaches at the tip when there is no base to go to', () => {
    const [leave] = planRollback({
      ...base,
      checkedOutHere: true,
      leaveTo: 'a'.repeat(40),
    }).steps;
    expect(leave?.target).toBe('a'.repeat(40));
  });

  it('refuses when the working tree here is dirty', () => {
    const plan = planRollback({ ...base, checkedOutHere: true, localDirty: true });
    expect(plan.safe).toBe(false);
    expect(plan.refusals[0]).toContain('checked out here');
  });

  it('discards the local changes under --force', () => {
    const plan = planRollback({ ...base, checkedOutHere: true, localDirty: true }, { force: true });
    expect(plan.safe).toBe(true);
    expect(plan.steps[0]?.action).toBe('leave-branch');
  });

  it('refuses rather than deleting the branch out from under HEAD', () => {
    const plan = planRollback({ ...base, checkedOutHere: true, leaveTo: null });
    expect(plan.safe).toBe(false);
    expect(plan.refusals[0]).toContain('nowhere to move HEAD');
  });

  it('does not plan a departure it was not standing on', () => {
    expect(actionsOf({ ...base, leaveTo: null })).toEqual(['delete-branch']);
  });
});

describe('formatRollbackPlan', () => {
  it('leads with the refusal and shows no steps', () => {
    const text = formatRollbackPlan(
      planRollback({ ...base, worktreePath: '/wt/x', worktreeDirty: true }),
    );
    expect(text).toContain('✗ refused');
    expect(text).not.toContain('delete-branch');
  });

  it('lists what is kept alongside what is removed', () => {
    const text = formatRollbackPlan(planRollback({ ...base, unmergedCommits: 1 }));
    expect(text).toContain('preserve-tip');
    expect(text).toContain('kept:');
  });

  it('says so plainly when there is nothing to do', () => {
    expect(formatRollbackPlan(planRollback({ ...base, branchExists: false }))).toContain(
      'nothing to roll back',
    );
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRevertSubject } from '@sdlc-on-fire/core';
import { createGitManager } from '@sdlc-on-fire/daemon';
import { claimWorkItem, init } from './commands.js';
import { branchFor } from './branch.js';
import { checkGuard } from './guard.js';
import { rollbackWorkItem } from './rollback.js';

/**
 * `sdlc rollback` against real git and real PGlite (P6-SURFACE-06).
 *
 * The planning decisions are unit-tested in core without a repository. What is
 * only checkable here is the part that was worth building at all: that each
 * step does to git what the plan says it does, that git accepts the *order*
 * the plan puts them in, and that the abandoned tip is genuinely recoverable
 * after the branch is gone.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const run = promisify(execFile);
let root: string;

async function git(args: readonly string[], cwd = root): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd });
  return stdout;
}

async function writeCard(id: string, title: string): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.md`),
    [
      '---',
      '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
      `id: ${id}`,
      'kind: task',
      `title: ${title}`,
      'status: In Progress',
      'lifecycle_state: implement',
      'work_type: task',
      'preset: standard',
      'risk_level: low',
      'created_at: 2026-08-10T00:00:00.000Z',
      'updated_at: 2026-08-10T00:00:00.000Z',
      '---',
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** Puts a commit on `branch`, then returns to main. */
async function commitOnBranch(branch: string, file: string, body: string): Promise<string> {
  await git(['checkout', '-q', '-b', branch, 'main']);
  await fs.writeFile(path.join(root, file), body, 'utf8');
  await git(['add', file]);
  await git(['commit', '-qm', `feat: ${file}`]);
  const sha = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['checkout', '-q', 'main']);
  return sha;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rollback-')));
  await git(['init', '-q', '--initial-branch=main']);
  await git(['config', 'user.email', 't@e.com']);
  await git(['config', 'user.name', 'T']);
  await init(root, { database: 'skip' });
  await git(['add', '-A']);
  await git(['commit', '-qm', 'chore: init']);
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('abandoning an unmerged branch', () => {
  it('deletes the branch and leaves the tip recoverable', async () => {
    await writeCard('TASK-001', 'Abandon me');
    const branch = (await branchFor(root, 'TASK-001')).branch;
    const tip = await commitOnBranch(branch, 'a.txt', 'work in progress');

    const result = await rollbackWorkItem(root, 'TASK-001', { apply: true });

    expect(result.executed.map((step) => step.action)).toEqual(['preserve-tip', 'delete-branch']);
    expect((await git(['branch', '--list'])).includes(branch)).toBe(false);

    // The point of the ref: the commit is still there, by name, with no reflog
    // archaeology and no 30-day clock.
    expect(result.recoverableFrom).toBe(`refs/sdlcof/abandoned/${branch}`);
    expect((await git(['rev-parse', result.recoverableFrom ?? ''])).trim()).toBe(tip);
    expect(await git(['show', '--format=', '--name-only', tip])).toContain('a.txt');
  }, 180_000);

  it('recovers the abandoned work back onto a branch', async () => {
    await writeCard('TASK-002', 'Recover me');
    const branch = (await branchFor(root, 'TASK-002')).branch;
    await commitOnBranch(branch, 'b.txt', 'nearly right');
    const result = await rollbackWorkItem(root, 'TASK-002', { apply: true });

    await git(['checkout', '-q', '-b', 'second-try', result.recoverableFrom ?? '']);
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf8')).toBe('nearly right');
  }, 180_000);

  it('touches nothing without --apply', async () => {
    await writeCard('TASK-003', 'Dry run');
    const branch = (await branchFor(root, 'TASK-003')).branch;
    await commitOnBranch(branch, 'c.txt', 'still here');

    const result = await rollbackWorkItem(root, 'TASK-003');
    expect(result.plan.safe).toBe(true);
    expect(result.plan.steps.length).toBeGreaterThan(0);
    expect(result.executed).toEqual([]);
    expect((await git(['branch', '--list'])).includes(branch)).toBe(true);
  }, 180_000);
});

describe('the branch you are standing on', () => {
  it('moves HEAD to the base and then deletes the branch', async () => {
    await writeCard('TASK-014', 'Standing on it');
    const branch = (await branchFor(root, 'TASK-014')).branch;
    await commitOnBranch(branch, 'h.txt', 'in progress');
    await git(['checkout', '-q', branch]);

    // The constraint this step exists for, asserted rather than assumed.
    await expect(git(['branch', '-D', branch])).rejects.toThrow(/checked out|cannot delete/i);

    const result = await rollbackWorkItem(root, 'TASK-014', { apply: true });
    expect(result.executed.map((step) => step.action)).toEqual([
      'leave-branch',
      'preserve-tip',
      'delete-branch',
    ]);
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect((await git(['branch', '--list'])).includes(branch)).toBe(false);
  }, 180_000);

  it('refuses when the tree it would leave is dirty, and moves nothing', async () => {
    await writeCard('TASK-015', 'Dirty here');
    const branch = (await branchFor(root, 'TASK-015')).branch;
    await commitOnBranch(branch, 'i.txt', 'committed');
    await git(['checkout', '-q', branch]);
    // A *tracked* modification. An untracked file would not block the move, and
    // there is a test below saying so.
    await fs.writeFile(path.join(root, 'i.txt'), 'edited, not committed', 'utf8');

    const result = await rollbackWorkItem(root, 'TASK-015', { apply: true });
    expect(result.plan.safe).toBe(false);
    expect(result.plan.refusals[0]).toContain('checked out here');
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branch);
    expect(await fs.readFile(path.join(root, 'i.txt'), 'utf8')).toBe('edited, not committed');
    // And nothing was half-done: no recovery ref was written either.
    await expect(git(['rev-parse', `refs/sdlcof/abandoned/${branch}`])).rejects.toThrow();

    await git(['checkout', '-q', '--force', 'main']);
  }, 180_000);

  it('discards the tracked changes under --force and still leaves the branch', async () => {
    await writeCard('TASK-018', 'Forced off');
    const branch = (await branchFor(root, 'TASK-018')).branch;
    await commitOnBranch(branch, 'l.txt', 'committed');
    await git(['checkout', '-q', branch]);
    await fs.writeFile(path.join(root, 'l.txt'), 'edited, not committed', 'utf8');

    // Plain `git checkout main` refuses here: `l.txt` exists only on the branch,
    // so the move would overwrite the edit. This is what --force is for.
    await expect(git(['checkout', '-q', 'main'])).rejects.toThrow(/would be overwritten/);

    const result = await rollbackWorkItem(root, 'TASK-018', { apply: true, force: true });
    expect(result.executed.map((step) => step.action)).toContain('leave-branch');
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect((await git(['branch', '--list'])).includes(branch)).toBe(false);
    // The edit is gone, as --force said it would be — and the commits are not.
    await expect(fs.stat(path.join(root, 'l.txt'))).rejects.toThrow();
    expect((await git(['rev-parse', `refs/sdlcof/abandoned/${branch}`])).trim()).toHaveLength(40);
  }, 180_000);

  it('is not blocked by untracked files, which a checkout leaves alone', async () => {
    await writeCard('TASK-017', 'Untracked around');
    const branch = (await branchFor(root, 'TASK-017')).branch;
    await commitOnBranch(branch, 'k.txt', 'committed');
    await git(['checkout', '-q', branch]);
    await fs.writeFile(path.join(root, 'scratch.txt'), 'not in git', 'utf8');

    const result = await rollbackWorkItem(root, 'TASK-017', { apply: true });
    expect(result.plan.safe).toBe(true);
    expect(result.executed.map((step) => step.action)).toContain('leave-branch');
    // Still there, untouched — which is why it was never worth refusing over.
    expect(await fs.readFile(path.join(root, 'scratch.txt'), 'utf8')).toBe('not in git');
  }, 180_000);

  it('detaches at the tip when the base ref is not there', async () => {
    await writeCard('TASK-016', 'Nowhere to go');
    const branch = (await branchFor(root, 'TASK-016')).branch;
    const tip = await commitOnBranch(branch, 'j.txt', 'orphan');
    await git(['checkout', '-q', branch]);

    const result = await rollbackWorkItem(root, 'TASK-016', {
      apply: true,
      base: 'no-such-branch',
    });
    expect(result.executed.map((step) => step.action)).toEqual([
      'leave-branch',
      'preserve-tip',
      'delete-branch',
    ]);
    expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(tip);
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');

    await git(['checkout', '-q', 'main']);
  }, 180_000);
});

describe('worktrees', () => {
  it('removes the worktree before the branch — git refuses the other order', async () => {
    await writeCard('TASK-004', 'In a worktree');
    const branch = (await branchFor(root, 'TASK-004')).branch;
    const worktree = path.join(root, '..', path.basename(root) + '-wt');
    await git(['worktree', 'add', '-q', '-b', branch, worktree, 'main']);

    // The constraint this ordering exists for, asserted rather than assumed.
    await expect(git(['branch', '-D', branch])).rejects.toThrow(/checked out|used by worktree/);

    const result = await rollbackWorkItem(root, 'TASK-004', { apply: true });
    expect(result.executed.map((step) => step.action)).toEqual([
      'remove-worktree',
      'delete-branch',
    ]);
    expect((await git(['branch', '--list'])).includes(branch)).toBe(false);
    await expect(fs.stat(worktree)).rejects.toThrow();
  }, 180_000);

  it('refuses a dirty worktree, and leaves everything standing', async () => {
    await writeCard('TASK-005', 'Dirty');
    const branch = (await branchFor(root, 'TASK-005')).branch;
    const worktree = path.join(root, '..', path.basename(root) + '-dirty');
    await git(['worktree', 'add', '-q', '-b', branch, worktree, 'main']);
    await fs.writeFile(path.join(worktree, 'unsaved.txt'), 'not committed', 'utf8');

    const result = await rollbackWorkItem(root, 'TASK-005', { apply: true });
    expect(result.plan.safe).toBe(false);
    expect(result.plan.refusals[0]).toContain('--force');
    expect(result.executed).toEqual([]);
    expect((await git(['branch', '--list'])).includes(branch)).toBe(true);
    expect(await fs.readFile(path.join(worktree, 'unsaved.txt'), 'utf8')).toBe('not committed');

    await git(['worktree', 'remove', '--force', worktree]);
  }, 180_000);

  it('discards the dirty worktree under --force', async () => {
    await writeCard('TASK-006', 'Forced');
    const branch = (await branchFor(root, 'TASK-006')).branch;
    const worktree = path.join(root, '..', path.basename(root) + '-forced');
    await git(['worktree', 'add', '-q', '-b', branch, worktree, 'main']);
    await fs.writeFile(path.join(worktree, 'unsaved.txt'), 'goodbye', 'utf8');

    const result = await rollbackWorkItem(root, 'TASK-006', { apply: true, force: true });
    expect(result.plan.safe).toBe(true);
    expect(result.executed.map((step) => step.action)).toContain('remove-worktree');
    await expect(fs.stat(worktree)).rejects.toThrow();
  }, 180_000);
});

describe('work that already landed', () => {
  it('reverts it instead of deleting a branch that would undo nothing', async () => {
    await writeCard('TASK-007', 'Landed');
    await fs.writeFile(path.join(root, 'landed.txt'), 'shipped', 'utf8');
    await git(['add', 'landed.txt']);
    await git(['commit', '-qm', 'feat: land TASK-007']);

    const result = await rollbackWorkItem(root, 'TASK-007', { apply: true });
    expect(result.executed.map((step) => step.action)).toEqual(['revert-landed']);
    expect(result.revertSha).toBeDefined();
    await expect(fs.stat(path.join(root, 'landed.txt'))).rejects.toThrow();
  }, 180_000);

  it('writes a revert the guard can find — the two halves of FEAT-GIT-007 meet here', async () => {
    await writeCard('TASK-008', 'Guarded');
    await fs.writeFile(
      path.join(root, 'discount.ts'),
      'export function computeDiscount(): number {\n  return 0;\n}\n',
      'utf8',
    );
    await git(['add', 'discount.ts']);
    await git(['commit', '-qm', 'feat: add computeDiscount for TASK-008']);

    await rollbackWorkItem(root, 'TASK-008', { apply: true });
    const subject = (await git(['log', '-1', '--format=%s'])).trim();
    expect(isRevertSubject(subject)).toBe(true);

    // Now re-add the same entity. The guard must see the rollback's own revert
    // and ask about it — that is the whole reason the subject shape is shared.
    await fs.writeFile(
      path.join(root, 'discount.ts'),
      'export function computeDiscount(): number {\n  return 1;\n}\n',
      'utf8',
    );
    // Staged, because `git diff HEAD` — what the guard reads — does not see an
    // untracked file. Nor would a commit.
    await git(['add', 'discount.ts']);
    const guard = await checkGuard(root, { message: 'feat: bring discounts back' });
    expect(guard.revertsScanned).toBeGreaterThan(0);
    expect(guard.guard.unacknowledged.map((f) => f.entity)).toContain('computeDiscount');
  }, 180_000);
});

describe('the claim (ADR-0048)', () => {
  it('refuses to roll back work somebody else holds', async () => {
    await writeCard('TASK-009', 'Contested');
    const branch = (await branchFor(root, 'TASK-009')).branch;
    await commitOnBranch(branch, 'd.txt', 'theirs');
    await claimWorkItem(root, 'TASK-009', 'bob');

    const result = await rollbackWorkItem(root, 'TASK-009', { actor: 'alice', apply: true });
    expect(result.plan.safe).toBe(false);
    expect(result.plan.refusals[0]).toContain('"bob"');
    expect((await git(['branch', '--list'])).includes(branch)).toBe(true);
  }, 180_000);

  it('releases the claim it holds, so the item can be picked up again', async () => {
    await writeCard('TASK-010', 'Mine');
    const branch = (await branchFor(root, 'TASK-010')).branch;
    await commitOnBranch(branch, 'e.txt', 'mine');
    await claimWorkItem(root, 'TASK-010', 'alice');

    const result = await rollbackWorkItem(root, 'TASK-010', { actor: 'alice', apply: true });
    expect(result.executed.map((step) => step.action)).toContain('release-claim');

    // Proof it is actually free: someone else can now claim it.
    const reclaimed = await claimWorkItem(root, 'TASK-010', 'bob');
    expect(reclaimed.granted).toBe(true);
    expect(reclaimed.claimedBy).toBe('bob');
  }, 180_000);
});

describe('what rollback keeps', () => {
  it('leaves the card and its context packs on disk', async () => {
    await writeCard('TASK-011', 'Keep the record');
    const branch = (await branchFor(root, 'TASK-011')).branch;
    await commitOnBranch(branch, 'f.txt', 'attempt');

    const packDir = path.join(root, '.sdlc', 'context-packs');
    await fs.mkdir(packDir, { recursive: true });
    await fs.writeFile(path.join(packDir, 'run-1.md'), 'what we asked for', 'utf8');

    await rollbackWorkItem(root, 'TASK-011', { apply: true });

    expect(await fs.readFile(path.join(packDir, 'run-1.md'), 'utf8')).toBe('what we asked for');
    await expect(
      fs.stat(path.join(root, 'kanban', '_inbox', 'TASK-011.md')),
    ).resolves.toBeDefined();
  }, 180_000);
});

describe('gathering the facts', () => {
  it('reports nothing to do for a work item that never got a branch', async () => {
    await writeCard('TASK-012', 'Never started');
    const result = await rollbackWorkItem(root, 'TASK-012', { apply: true });
    expect(result.plan.steps).toEqual([]);
    expect(result.executed).toEqual([]);
  }, 180_000);

  it('preserves the tip when the base ref does not exist rather than assuming merged', async () => {
    await writeCard('TASK-013', 'No such base');
    const branch = (await branchFor(root, 'TASK-013')).branch;
    await commitOnBranch(branch, 'g.txt', 'orphaned');

    const manager = createGitManager({ repoRoot: root });
    expect(await manager.resolveRef('no-such-branch')).toBeNull();

    const result = await rollbackWorkItem(root, 'TASK-013', {
      apply: true,
      base: 'no-such-branch',
    });
    expect(result.executed.map((step) => step.action)).toEqual(['preserve-tip', 'delete-branch']);
  }, 180_000);
});

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { createGitManager } from '../git/git-manager.js';
import { rebuildMirror } from './rebuild.js';

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
 * A-07, the empirical half: does worktree-per-work-item isolation reconcile
 * cleanly with the DB mirror when several actors touch the same repo at once?
 *
 * [ADR-0041](docs/.plan/decisions/ADR-0041-build-wave-execution-model.md)
 * settled the *design*; the assumption register asked for a stress test, on the
 * grounds that worktree/DB desync would undermine "the DB is a trustworthy,
 * rebuildable mirror" at exactly the moment it matters — concurrent work.
 *
 * The whole question turns on one structural fact: **worktrees share a `.git`
 * but not a working tree**, while the mirror is built by walking files under one
 * workspace root. So a card advanced inside a worktree is, from the mirror's
 * point of view, simply not there yet. What must never happen is the mirror
 * reporting a state that no tree on disk actually holds.
 *
 * Real git and real PGlite throughout: the failure being hunted is an
 * interaction between two real systems, and a mock of either would decide the
 * answer in advance.
 */

const run = promisify(execFile);

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let root: string;

const card = (id: string, stage: string): string =>
  `---\nid: ${id}\nkind: task\ntitle: Card ${id}\nstatus: In Progress\n` +
  `lifecycle_state: ${stage}\nwork_type: task\npreset: standard\n---\n\n` +
  `## Description\n\nWork for ${id}.\n`;

const cardPath = (base: string, id: string): string =>
  path.join(base, 'kanban', '_inbox', `${id}.md`);

async function stageInMirror(id: string): Promise<string | undefined> {
  const rows = await db.query<{ lifecycle_state: string }>(
    'SELECT lifecycle_state FROM work_items WHERE id = $1;',
    [id],
  );
  return rows[0]?.lifecycle_state;
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'a07-')));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);

  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  for (const id of ['TASK-001', 'TASK-002', 'TASK-003']) {
    await fs.writeFile(cardPath(root, id), card(id, 'implement'), 'utf8');
  }

  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'a@b.c'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'seed'], { cwd: root });
}, 180_000);

afterEach(async () => {
  await db.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('A-07 — worktree isolation against the DB mirror', () => {
  it('does not let a worktree-only advance leak into the mirror', async () => {
    const git = createGitManager({ repoRoot: root });
    const wt = path.join(path.dirname(root), `${path.basename(root)}-wt1`);
    await git.addWorktree(wt, 'task/TASK-001');

    // The agent advances its card inside its own worktree and commits there.
    await fs.writeFile(cardPath(wt, 'TASK-001'), card('TASK-001', 'review'), 'utf8');
    await run('git', ['add', '-A'], { cwd: wt });
    await run('git', ['commit', '-qm', 'advance TASK-001'], { cwd: wt });

    await rebuildMirror(root, port);

    // `implement`, not `review`: the mirror reflects the tree it was built
    // from. Reporting `review` here would mean the mirror had adopted a state
    // no file under its own root holds — the desync A-07 is about.
    expect(await stageInMirror('TASK-001')).toBe('implement');

    await git.removeWorktree(wt, { force: true });
  }, 180_000);

  it('converges on the main tree once the branch merges', async () => {
    const git = createGitManager({ repoRoot: root });
    const wt = path.join(path.dirname(root), `${path.basename(root)}-wt2`);
    await git.addWorktree(wt, 'task/TASK-002');

    await fs.writeFile(cardPath(wt, 'TASK-002'), card('TASK-002', 'review'), 'utf8');
    await run('git', ['add', '-A'], { cwd: wt });
    await run('git', ['commit', '-qm', 'advance TASK-002'], { cwd: wt });

    await rebuildMirror(root, port);
    expect(await stageInMirror('TASK-002')).toBe('implement');

    await run('git', ['merge', '--no-edit', '-q', 'task/TASK-002'], { cwd: root });
    await rebuildMirror(root, port);

    // Git is the ground truth and the mirror follows it. This is the property
    // that makes the mirror disposable: no reconciliation protocol between
    // worktrees is needed, because the merge already is one.
    expect(await stageInMirror('TASK-002')).toBe('review');

    await git.removeWorktree(wt, { force: true });
  }, 180_000);

  it('survives concurrent worktrees advancing disjoint cards', async () => {
    const git = createGitManager({ repoRoot: root });
    const trees = await Promise.all(
      ['TASK-001', 'TASK-002', 'TASK-003'].map(async (id, i) => {
        const wt = path.join(path.dirname(root), `${path.basename(root)}-c${String(i)}`);
        await git.addWorktree(wt, `task/${id}`);
        return { id, wt };
      }),
    );

    // Three agents, at the same time, each inside its own worktree — the shape
    // ADR-0041 prescribes and the one A-07 doubts.
    await Promise.all(
      trees.map(async ({ id, wt }) => {
        await fs.writeFile(cardPath(wt, id), card(id, 'review'), 'utf8');
        await run('git', ['add', '-A'], { cwd: wt });
        await run('git', ['commit', '-qm', `advance ${id}`], { cwd: wt });
      }),
    );

    for (const { id } of trees) {
      await run('git', ['merge', '--no-edit', '-q', `task/${id}`], { cwd: root });
    }
    const result = await rebuildMirror(root, port);

    expect(result.failed).toEqual([]);
    for (const { id } of trees) {
      expect(await stageInMirror(id)).toBe('review');
    }

    for (const { wt } of trees) await git.removeWorktree(wt, { force: true });
  }, 300_000);

  it('reports a rebuild run against a dirty tree without inventing a resolution', async () => {
    // A human editing in the main tree while an agent works in a worktree is the
    // ordinary case, not an exotic one. The mirror takes what is on disk —
    // uncommitted included — because that is what the next command will read.
    await fs.writeFile(cardPath(root, 'TASK-003'), card('TASK-003', 'test'), 'utf8');
    await rebuildMirror(root, port);
    expect(await stageInMirror('TASK-003')).toBe('test');

    // And a rebuild is idempotent: running it twice against the same tree must
    // not move anything, or "rebuild when in doubt" stops being safe advice.
    const second = await rebuildMirror(root, port);
    expect(second.failed).toEqual([]);
    expect(await stageInMirror('TASK-003')).toBe('test');
  }, 180_000);
});

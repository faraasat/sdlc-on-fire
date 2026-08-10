import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, claimWorkItem } from './commands.js';
import { branchFor } from './branch.js';

/**
 * `sdlc branch` — deriving a branch name from the work-item hierarchy (P1-GIT-03,
 * ADR-0048).
 *
 * Two capabilities existed and could not be reached: `buildBranchName` composed
 * `<type>/<epic>-<feature>-<task-id>-<slug>` and nothing called it, and
 * `work_items.parent_id` had a column *and an index* that nothing wrote. So the
 * hierarchy the branch name is supposed to encode was not in the mirror at all.
 * These tests are the reachability check, run against real git and real PGlite.
 */

const run = promisify(execFile);
let root: string;

interface CardFields {
  readonly kind: string;
  readonly title: string;
  readonly parent?: string;
}

async function writeCard(id: string, fields: CardFields): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    `id: ${id}`,
    `kind: ${fields.kind}`,
    `title: ${fields.title}`,
    'status: In Progress',
    'lifecycle_state: implement',
    `work_type: ${fields.kind === 'task' ? 'task' : 'feature'}`,
    'preset: standard',
    'risk_level: low',
    ...(fields.parent === undefined ? [] : [`parent_id: ${fields.parent}`]),
    'created_at: 2026-08-10T00:00:00.000Z',
    'updated_at: 2026-08-10T00:00:00.000Z',
    '---',
    '',
    'body',
    '',
  ];
  await fs.writeFile(path.join(dir, `${id}.md`), lines.join('\n'), 'utf8');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'branch-')));
  await run('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root);
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-qm', 'chore: init'], { cwd: root });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('deriving the name from the hierarchy', () => {
  it('walks epic → feature → task and encodes all three', async () => {
    await writeCard('EPIC-001', { kind: 'epic', title: 'Billing overhaul' });
    await writeCard('FEAT-001', { kind: 'feature', title: 'Invoice export', parent: 'EPIC-001' });
    await writeCard('TASK-001', { kind: 'task', title: 'Escape commas', parent: 'FEAT-001' });

    const result = await branchFor(root, 'TASK-001');
    expect(result.branch).toBe('feat/billing-overhaul-invoice-export-TASK-001-escape-commas');
    // The task id is preserved verbatim — it is the anchor that makes the branch
    // traceable back without a lookup, so lowercasing would break `git log --grep`.
    expect(result.branch).toContain('TASK-001');
    expect(result.hierarchy.map((entry) => entry.id)).toEqual(['EPIC-001', 'FEAT-001']);
  }, 180_000);

  it('omits the segments an item does not have', async () => {
    await writeCard('TASK-002', { kind: 'task', title: 'Standalone chore' });
    const result = await branchFor(root, 'TASK-002');
    expect(result.branch).toBe('feat/TASK-002-standalone-chore');
    expect(result.hierarchy).toEqual([]);
  }, 180_000);

  it('names a bug branch fix/, not feat/', async () => {
    await writeCard('BUG-001', { kind: 'bug', title: 'Crash on empty file' });
    expect((await branchFor(root, 'BUG-001')).branch).toMatch(/^fix\//);
  }, 180_000);

  it('reports a parent cycle instead of walking it forever', async () => {
    // `parent_id` is a plain frontmatter field a human edits, so A → B → A is one
    // typo away. A walk that trusted the data would hang rather than explain.
    await writeCard('FEAT-002', { kind: 'feature', title: 'Loop a', parent: 'FEAT-003' });
    await writeCard('FEAT-003', { kind: 'feature', title: 'Loop b', parent: 'FEAT-002' });

    await expect(branchFor(root, 'FEAT-002')).rejects.toThrow(/cycles at/);
  }, 180_000);
});

describe('the claim check (ADR-0048)', () => {
  it('refuses to create a branch for unclaimed work', async () => {
    await writeCard('TASK-003', { kind: 'task', title: 'Unclaimed' });

    const result = await branchFor(root, 'TASK-003', { actor: 'alice', create: true });
    expect(result.created).toBe(false);
    expect(result.refusal).toMatch(/is not claimed/);
    // And it did not create the branch as a side effect of refusing.
    const branches = await run('git', ['branch', '--list'], { cwd: root });
    expect(branches.stdout).not.toContain('TASK-003');
  }, 180_000);

  it('refuses when someone else holds the claim', async () => {
    await writeCard('TASK-004', { kind: 'task', title: 'Contested' });
    await claimWorkItem(root, 'TASK-004', 'bob');

    const result = await branchFor(root, 'TASK-004', { actor: 'alice', create: true });
    expect(result.created).toBe(false);
    expect(result.refusal).toMatch(/claimed by "bob"/);
  }, 180_000);

  it('creates and checks out the branch when the claim is yours', async () => {
    await writeCard('TASK-005', { kind: 'task', title: 'Mine' });
    await claimWorkItem(root, 'TASK-005', 'alice');

    const result = await branchFor(root, 'TASK-005', { actor: 'alice', create: true });
    expect(result.created).toBe(true);

    const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
    expect(current.stdout.trim()).toBe(result.branch);
  }, 180_000);

  it('reports the name without a claim when not creating', async () => {
    // Asking what a branch *would* be called is a read, and requiring a claim for
    // it would make the naming rule unusable for planning.
    await writeCard('TASK-006', { kind: 'task', title: 'Just asking' });
    const result = await branchFor(root, 'TASK-006');
    expect(result.refusal).toBeUndefined();
    expect(result.branch).toBe('feat/TASK-006-just-asking');
  }, 180_000);
});

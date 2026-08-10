import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, claimWorkItem } from './commands.js';
import { verifyWorkItem } from './advance.js';
import { prFor } from './pr.js';

/**
 * `sdlc pr` — the evidence bundle assembled from what actually ran (P1-GIT-02).
 *
 * `renderPrBody` shipped with P1-SKILL-02 and had no caller anywhere. Here that
 * mattered more than usual: the whole argument for the bundle is that a reviewer
 * sees which commands ran and what they said instead of a sentence claiming
 * everything passed — and a renderer nothing calls produces no such body.
 *
 * So these tests drive the command, against real git and real PGlite, and check
 * the properties a reviewer depends on: that the rows are this item's, that
 * failures and stale runs are shown rather than filtered, and that the body
 * never says the gate passed when it did not.
 */

const run = promisify(execFile);
let root: string;

const CARD = (id: string, verify: string, stage = 'implement'): string =>
  [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    `id: ${id}`,
    'kind: task',
    `title: Validate ${id}`,
    'status: In Progress',
    `lifecycle_state: ${stage}`,
    'work_type: task',
    'preset: standard',
    'risk_level: low',
    `verify: ${verify}`,
    'done:',
    '  - tests pass',
    'created_at: 2026-08-10T00:00:00.000Z',
    'updated_at: 2026-08-10T00:00:00.000Z',
    '---',
    '',
    'Escapes commas in the CSV writer.',
    '',
  ].join('\n');

async function writeCard(id: string, verify = 'node test.js'): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), CARD(id, verify), 'utf8');
}

const setTest = (passing: boolean): Promise<void> =>
  fs.writeFile(
    path.join(root, 'test.js'),
    passing
      ? 'import assert from "node:assert"; assert.equal(1,1);'
      : 'import assert from "node:assert"; assert.equal(1,2,"deliberately failing");',
    'utf8',
  );

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pr-')));
  await run('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"d","type":"module"}', 'utf8');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the bundle is what ran', () => {
  it('renders a body carrying the recorded run, not a claim about it', async () => {
    await writeCard('TASK-001');
    await setTest(true);
    await claimWorkItem(root, 'TASK-001', 'alice');
    await verifyWorkItem(root, 'TASK-001', { actor: 'alice' });

    const result = await prFor(root, 'TASK-001');
    expect(result.evidenceCount).toBe(1);
    expect(result.body).toContain('TASK-001');
    // The command's own record, so a reviewer can see what produced the row.
    expect(result.body).toContain('daemon');
    expect(result.gatePasses).toBe(true);
  }, 180_000);

  it('shows a failing run rather than omitting it', async () => {
    // A reviewer who sees only the flattering rows is worse informed than one
    // who sees none.
    await writeCard('TASK-002');
    await setTest(false);
    await claimWorkItem(root, 'TASK-002', 'alice');
    await verifyWorkItem(root, 'TASK-002', { actor: 'alice' });

    const result = await prFor(root, 'TASK-002');
    expect(result.evidenceCount).toBe(1);
    expect(result.gatePasses).toBe(false);
  }, 180_000);

  it('never reports a passing gate on evidence that no longer applies', async () => {
    await writeCard('TASK-003');
    await setTest(true);
    await claimWorkItem(root, 'TASK-003', 'alice');
    await verifyWorkItem(root, 'TASK-003', { actor: 'alice' });
    expect((await prFor(root, 'TASK-003')).gatePasses).toBe(true);

    // The code moves under the evidence without a commit.
    await setTest(false);
    const after = await prFor(root, 'TASK-003');
    expect(after.gatePasses).toBe(false);
    // Still counted and shown — evidence that exists but no longer applies is a
    // different fact from no evidence at all.
    expect(after.evidenceCount).toBe(1);
  }, 180_000);

  it('carries only this item’s evidence', async () => {
    await writeCard('TASK-004');
    await writeCard('TASK-005');
    await setTest(true);
    await claimWorkItem(root, 'TASK-004', 'alice');
    await verifyWorkItem(root, 'TASK-004', { actor: 'alice' });

    const result = await prFor(root, 'TASK-005');
    expect(result.evidenceCount).toBe(0);
    expect(result.gatePasses).toBe(false);
  }, 180_000);

  it('uses the card’s own body as the summary', async () => {
    // Asking a model to describe the change would put an unverified sentence at
    // the top of a document whose entire point is that its claims are checkable.
    await writeCard('TASK-006');
    const result = await prFor(root, 'TASK-006');
    expect(result.body).toContain('Escapes commas in the CSV writer.');
  }, 180_000);

  it('titles the PR conventionally, anchored on the work-item id', async () => {
    await writeCard('TASK-007');
    const result = await prFor(root, 'TASK-007');
    expect(result.title).toMatch(/^feat\(TASK-007\): /);
  }, 180_000);
});

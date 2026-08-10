import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, claimWorkItem, listWorkItems, captureItem, triageItem } from './commands.js';
import { advanceWorkItem, verifyWorkItem } from './advance.js';

/**
 * The gate loop, end to end (`verify` → `claim` → `advance`).
 *
 * These exist because a blind evaluation of the previous build broke the
 * product's entire thesis in about a minute: it wrote a real failing test suite,
 * hand-edited `lifecycle_state: done`, and nothing objected — not `instructions`,
 * not `status`, not `db:rebuild`, not the git hooks. Every piece of the gate was
 * built and unit-tested; none of it was reachable from a command.
 *
 * So what is tested here is *reachability*, not just correctness.
 */

const run = promisify(execFile);
let root: string;

const CARD = (verify: string) =>
  [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    'id: TASK-001',
    'kind: task',
    'title: Escape commas',
    'status: In Progress',
    'lifecycle_state: implement',
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
    'body',
    '',
  ].join('\n');

async function writeCard(verify = 'node test.js') {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'TASK-001.md'), CARD(verify), 'utf8');
}

const setTest = (passing: boolean) =>
  fs.writeFile(
    path.join(root, 'test.js'),
    passing
      ? 'import assert from "node:assert"; assert.equal(1,1);'
      : 'import assert from "node:assert"; assert.equal(1,2,"deliberately failing");',
    'utf8',
  );

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-loop-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root);
  await writeCard();
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"d","type":"module"}', 'utf8');
}, 120_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('verify runs the command itself', () => {
  it('reports a real failure as a result, not an exception', async () => {
    // "The tests failed" is the most important thing this can learn; throwing
    // would turn it into a stack trace instead of evidence.
    await setTest(false);
    const result = await verifyWorkItem(root, 'TASK-001');
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.evidenceId).toBeGreaterThan(0);
  }, 120_000);

  it('records evidence attributed to the daemon, never to an agent', async () => {
    await setTest(true);
    const result = await verifyWorkItem(root, 'TASK-001');
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/passed/);
  }, 120_000);

  it('refuses a card with no verify command, and says what to add', async () => {
    await fs.writeFile(
      path.join(root, 'kanban', '_inbox', 'TASK-001.md'),
      CARD('x').replace('verify: x\n', ''),
      'utf8',
    );
    await expect(verifyWorkItem(root, 'TASK-001')).rejects.toThrow(/verify:/);
  }, 120_000);
});

describe('advance refuses without real, current evidence', () => {
  it('blocks when nothing has been verified', async () => {
    await claimWorkItem(root, 'TASK-001', 'tester');
    const result = await advanceWorkItem(root, 'TASK-001');

    expect(result.moved).toBe(false);
    // The refusal must be actionable: naming the command that fixes it.
    expect(result.refusals.join(' ')).toMatch(/sdlc verify TASK-001/);
  }, 120_000);

  it('blocks on failing evidence with a different remedy than missing evidence', async () => {
    // "Run the check" and "fix the code" are different instructions, and
    // collapsing them sends the user to the wrong place.
    await claimWorkItem(root, 'TASK-001', 'tester');
    await setTest(false);
    await verifyWorkItem(root, 'TASK-001');

    const result = await advanceWorkItem(root, 'TASK-001');
    expect(result.moved).toBe(false);
    expect(result.refusals.join(' ')).toMatch(/fix the code/);
  }, 120_000);

  it('blocks an unclaimed item, and the claim command resolves it', async () => {
    // A refusal a user cannot act on teaches them the tool is broken rather
    // than strict, so the guard and its remedy ship together.
    await setTest(true);
    await verifyWorkItem(root, 'TASK-001');

    const unclaimed = await advanceWorkItem(root, 'TASK-001');
    expect(unclaimed.refusals.join(' ')).toMatch(/no live claim/);

    await claimWorkItem(root, 'TASK-001', 'tester');
    const claimed = await advanceWorkItem(root, 'TASK-001');
    expect(claimed.moved).toBe(true);
  }, 120_000);

  it('moves once the evidence is real and current, and rewrites the card', async () => {
    await claimWorkItem(root, 'TASK-001', 'tester');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-001');

    const result = await advanceWorkItem(root, 'TASK-001');
    expect(result.moved).toBe(true);
    expect(result.from).toBe('implement');
    expect(result.to).toBe('test');

    // The file is the source of truth; the mirror follows.
    const card = await fs.readFile(path.join(root, 'kanban', '_inbox', 'TASK-001.md'), 'utf8');
    expect(card).toContain('lifecycle_state: test');
  }, 120_000);
});

describe('list', () => {
  it('shows a work item created moments ago, without a manual sync', async () => {
    // The first thing a user does after creating a work item is look for it.
    const result = await listWorkItems(root);
    expect(result.items.map((item) => item.id)).toContain('TASK-001');
  }, 120_000);
});

describe('soft insertion: capture and triage (P1-INS-01)', () => {
  it('captures with nothing but a sentence', async () => {
    // If capturing requires choosing a kind, a parent, a preset and a stage,
    // nobody captures anything — it goes in a text file instead, or is lost.
    const result = await captureItem(root, 'CSV parser chokes on quoted commas');
    expect(result.id).toMatch(/^CAP-\d+$/);
    const raw = await fs.readFile(path.join(root, result.filePath), 'utf8');
    expect(raw).toContain('lifecycle_state: capture');
  }, 120_000);

  it('does not disturb work in flight', async () => {
    // The whole promise of soft insertion: no claim touched, no stage moved.
    await claimWorkItem(root, 'TASK-001', 'alice');
    const before = await fs.readFile(path.join(root, 'kanban', '_inbox', 'TASK-001.md'), 'utf8');

    await captureItem(root, 'an unrelated idea');

    const after = await fs.readFile(path.join(root, 'kanban', '_inbox', 'TASK-001.md'), 'utf8');
    expect(after).toBe(before);
  }, 120_000);

  it('promotes a capture into a real work item, carrying the wording over', async () => {
    const captured = await captureItem(root, 'quoted commas break the parser');
    const triaged = await triageItem(root, captured.id, 'bug');

    expect(triaged.workItemId).toMatch(/^BUG-\d+$/);
    const raw = await fs.readFile(path.join(root, triaged.filePath), 'utf8');
    expect(raw).toContain('quoted commas break the parser');
    expect(raw).toContain(captured.id);
  }, 120_000);

  it('leaves the capture in place rather than deleting it', async () => {
    // The original wording is often the only record of what was actually meant.
    const captured = await captureItem(root, 'something subtle about encodings');
    await triageItem(root, captured.id, 'task');
    await expect(fs.stat(path.join(root, captured.filePath))).resolves.toBeDefined();
  }, 120_000);

  it('rejects an unknown kind at triage, naming the valid ones', async () => {
    const captured = await captureItem(root, 'x');
    await expect(triageItem(root, captured.id, 'widget')).rejects.toThrow(/expected one of/);
  }, 120_000);
});

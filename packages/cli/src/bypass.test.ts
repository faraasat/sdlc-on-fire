import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, instructions, listWorkItems } from './commands.js';
import { advanceWorkItem, verifyWorkItem } from './advance.js';

/**
 * The three routes a blind adversarial evaluation used to reach `done` with a
 * red suite.
 *
 * The first version of the gate was correct in isolation and defeated in
 * practice, which is the only failure mode that matters. Each test here is one
 * of the evaluator's actual transcripts, replayed:
 *
 * 1. **Stale evidence.** Verify while green, then break the code without
 *    committing. HEAD is unchanged, so evidence recorded only `git_sha` and went
 *    on looking current. Closed by hashing the dirty tree.
 * 2. **A no-op `verify:`.** Point it at something that exits 0 and runs nothing.
 *    Closed by recording *how* the result was read — a parsed report of zero
 *    tests is a green run that proved nothing.
 * 3. **Someone else's green run.** Evidence was queried workspace-globally, so
 *    one passing run anywhere satisfied every item, and one failure anywhere
 *    flagged every item. Closed by reaching evidence through `gates`.
 *
 * They are written against the commands, not the functions underneath, because
 * the original bug was never in the logic — it was that nothing called it.
 */

const run = promisify(execFile);
let root: string;

const CARD = (id: string, verify: string, stage = 'implement') =>
  [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    `id: ${id}`,
    'kind: task',
    `title: Task ${id}`,
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
    'body',
    '',
  ].join('\n');

async function writeCard(id: string, verify: string, stage = 'implement'): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), CARD(id, verify, stage), 'utf8');
}

const setTest = (passing: boolean): Promise<void> =>
  fs.writeFile(
    path.join(root, 'test.js'),
    passing
      ? 'import assert from "node:assert"; assert.equal(1,1);'
      : 'import assert from "node:assert"; assert.equal(1,2,"deliberately failing");',
    'utf8',
  );

async function attestationOf(id: string): Promise<{ attestation: string; concern?: string }> {
  const listing = await listWorkItems(root);
  const found = listing.items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`${id} missing from the mirror`);
  return {
    attestation: found.attestation,
    ...(found.concern === undefined ? {} : { concern: found.concern }),
  };
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bypass-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"d","type":"module"}', 'utf8');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('bypass 1 — evidence that outlived the code it was about', () => {
  it('stops supporting a done claim once the uncommitted tree changes under it', async () => {
    await writeCard('TASK-001', 'node test.js');
    await setTest(true);

    const verified = await verifyWorkItem(root, 'TASK-001');
    expect(verified.ok).toBe(true);

    // The evaluator's move: mark it done on a genuinely green run, then break
    // the code without committing. Nothing about HEAD changes.
    await writeCard('TASK-001', 'node test.js', 'done');
    expect((await attestationOf('TASK-001')).attestation).toBe('supported');

    await setTest(false);
    const after = await attestationOf('TASK-001');
    expect(after.attestation).toBe('unsupported');
    expect(after.concern).toMatch(/predates the current working tree/);
  }, 180_000);
});

describe('bypass 2 — a verify command that runs nothing', () => {
  it('refuses to read an empty parsed suite as a pass', async () => {
    // A runner that reports, honestly, that it ran no tests. Exit code 0, and
    // indistinguishable from a green suite unless the count is read.
    await fs.writeFile(
      path.join(root, 'empty-runner.js'),
      'console.log(JSON.stringify({numTotalTests:0,numFailedTests:0,numPassedTests:0,testResults:[]}));',
      'utf8',
    );
    await writeCard('TASK-002', 'node empty-runner.js');

    const verified = await verifyWorkItem(root, 'TASK-002');
    expect(verified.ok).toBe(true); // exit 0 — the command genuinely succeeded

    await writeCard('TASK-002', 'node empty-runner.js', 'done');
    const attested = await attestationOf('TASK-002');
    expect(attested.attestation).toBe('unsupported');
    expect(attested.concern).toMatch(/executed 0 tests/);
  }, 180_000);

  it('records how the result was read, so an exit code is never mistaken for a suite', async () => {
    await writeCard('TASK-003', 'exit 0');
    const verified = await verifyWorkItem(root, 'TASK-003');
    expect(verified.report).toBe('exit-code-only');
    // ...and says so in the confidence, rather than flattering an unread result.
    expect(verified.confidence).toBeLessThan(0.95);
    expect(verified.summary).toMatch(/no test report was parsed/);
  }, 180_000);
});

describe('bypass 3 — one green run standing in for every item', () => {
  it('does not let another item’s passing evidence support this one', async () => {
    await writeCard('TASK-004', 'node test.js');
    await writeCard('TASK-005', 'node test.js', 'done');
    await setTest(true);

    // Only TASK-004 is verified. TASK-005 has never been checked at all.
    await verifyWorkItem(root, 'TASK-004');

    const attested = await attestationOf('TASK-005');
    expect(attested.attestation).toBe('unsupported');
    expect(attested.concern).toMatch(/no verify run was ever recorded for it/);
  }, 180_000);

  it('does not let another item’s failing run flag this one', async () => {
    await writeCard('TASK-006', 'node test.js');
    await writeCard('TASK-007', 'node test.js');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-007');
    await writeCard('TASK-007', 'node test.js', 'done');

    // A deliberately failing, unrelated run. Under the global query this flipped
    // the warning on for every done item in the workspace.
    await setTest(false);
    await verifyWorkItem(root, 'TASK-006');
    await setTest(true);

    expect((await attestationOf('TASK-007')).attestation).toBe('supported');
  }, 180_000);

  it('blocks an advance that only another item’s evidence would satisfy', async () => {
    await writeCard('TASK-008', 'node test.js', 'test');
    await writeCard('TASK-009', 'node test.js', 'test');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-009');

    const result = await advanceWorkItem(root, 'TASK-008');
    expect(result.moved).toBe(false);
    expect(result.refusals.join('\n')).toMatch(/no current test evidence/);
  }, 180_000);
});

describe('the warning reaches the command an agent actually reads', () => {
  it('surfaces an unsupported claim from `instructions`, not only from `list`', async () => {
    await writeCard('TASK-010', 'node test.js', 'done');
    const reported = await instructions(root, 'TASK-010');

    expect(reported.attestation).toBe('unsupported');
    expect(reported.concern).toMatch(/no verify run was ever recorded/);
    // The terminal answer is still correct — the point is that it no longer
    // arrives alone.
    expect(reported.terminal).toBe(true);
  }, 180_000);
});

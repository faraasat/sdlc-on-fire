import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimWorkItem, init, instructions, listWorkItems } from './commands.js';
import { advanceWorkItem, reopenWorkItem, verifyWorkItem } from './advance.js';
import { recordReview, SelfReviewError } from './review.js';

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
  await init(root, { database: 'skip' });
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
    // Stale, not unsupported: the run really did pass, against code that has
    // since moved. Those are different claims (see the v006 tests below).
    expect(after.attestation).toBe('stale');
    expect(after.concern).toMatch(/to confirm it still does/);
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
    // The report is in the message because the interesting failure is not
    // "wrong attestation" but "the runner's output was never read" — those look
    // identical from the attestation alone, and one is a platform problem.
    expect(
      attested.attestation,
      `report=${verified.report} testsRun=${String(verified.testsRun)}`,
    ).toBe('unsupported');
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
    expect(result.refusals.join('\n')).toMatch(/no test evidence for TASK-008/);
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

describe('the gate must not refuse work that is genuinely done', () => {
  it('advances after a real passing verify in a workspace with no git repository', async () => {
    // The case a blind evaluation actually hit. `sdlc init` never runs `git
    // init`, so a first-time user has a workspace and no repository — and the
    // dirty-tree hash fell into its own error path there, returning a fresh
    // time-based sentinel each call. Evidence was stale the instant it was
    // written, `advance` refused forever, and the message said "run verify" to
    // someone who had just run it.
    const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nogit-')));
    try {
      await init(bare, { database: 'skip' });
      await fs.writeFile(path.join(bare, 'package.json'), '{"name":"d","type":"module"}', 'utf8');
      await fs.writeFile(
        path.join(bare, 'test.js'),
        'import assert from "node:assert"; assert.equal(1,1);',
        'utf8',
      );
      const dir = path.join(bare, 'kanban', '_inbox');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'TASK-100.md'), CARD('TASK-100', 'node test.js'), 'utf8');

      const verified = await verifyWorkItem(bare, 'TASK-100');
      expect(verified.ok).toBe(true);

      await claimWorkItem(bare, 'TASK-100', 'alice');
      const moved = await advanceWorkItem(bare, 'TASK-100', { actor: 'alice' });
      // Asserting it *moved*, not merely that the wording changed: the previous
      // version of this test checked the refusal text and passed even with the
      // bug still in place.
      expect(moved.refusals).toEqual([]);
      expect(moved.moved).toBe(true);
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  }, 180_000);

  it('says the evidence is stale, not absent, when the code changed after the check', async () => {
    await writeCard('TASK-101', 'node test.js', 'test');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-101');

    // Same item, real passing run on record — then the code moves under it.
    await setTest(false);
    const result = await advanceWorkItem(root, 'TASK-101');
    expect(result.moved).toBe(false);
    const reasons = result.refusals.join('\n');
    expect(reasons).toMatch(/none describes the current tree/);
    expect(reasons).toMatch(/re-run/);
    // "Run verify" would send the user to do what they already did.
    expect(reasons).not.toMatch(/no test evidence for/);
  }, 180_000);
});

describe('retracting an unsupported claim', () => {
  it('walks a fabricated done back to implement', async () => {
    // Detection without remediation left the honest path harder than the
    // dishonest one: the flag was permanent and the only way to correct it was
    // to hand-edit the card — the same move that produced the false claim.
    await writeCard('TASK-200', 'node test.js', 'done');
    await setTest(true);

    const before = await attestationOf('TASK-200');
    expect(before.attestation).toBe('unsupported');

    const result = await reopenWorkItem(root, 'TASK-200');
    expect(result.reopened).toBe(true);
    expect(result.to).toBe('implement');
    expect(result.reason).toMatch(/no verify run was ever recorded/);

    // And the card on disk actually moved — the mirror is not the source.
    const card = await fs.readFile(path.join(root, 'kanban', '_inbox', 'TASK-200.md'), 'utf8');
    expect(card).toContain('lifecycle_state: implement');
  }, 180_000);

  it('refuses to reopen a claim its evidence supports', async () => {
    // A correction, not a general "move backwards": walking a legitimately-done
    // item back is a lifecycle decision, and no evidence says it should happen.
    await writeCard('TASK-201', 'node test.js');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-201');
    await writeCard('TASK-201', 'node test.js', 'done');
    expect((await attestationOf('TASK-201')).attestation).toBe('supported');

    const result = await reopenWorkItem(root, 'TASK-201');
    expect(result.reopened).toBe(false);
    expect(result.reason).toMatch(/its evidence supports that/);
  }, 180_000);

  it('refuses on an item that has claimed nothing', async () => {
    await writeCard('TASK-202', 'node test.js');
    const result = await reopenWorkItem(root, 'TASK-202');
    expect(result.reopened).toBe(false);
    expect(result.reason).toMatch(/nothing to retract/);
  }, 180_000);
});

describe('claim ownership (v005)', () => {
  it('refuses to advance an item someone else holds', async () => {
    // The lease was enforced only between competing `claim` calls, and every
    // command that actually did something to an item ignored who held it.
    await writeCard('TASK-203', 'node test.js', 'test');
    await setTest(true);
    await claimWorkItem(root, 'TASK-203', 'bob');
    await verifyWorkItem(root, 'TASK-203', { actor: 'bob' });

    const result = await advanceWorkItem(root, 'TASK-203', { actor: 'alice' });
    expect(result.moved).toBe(false);
    expect(result.refusals.join('\n')).toMatch(/claimed by "bob", not by "alice"/);
  }, 180_000);

  it('refuses to record evidence against someone else’s item', async () => {
    await writeCard('TASK-204', 'node test.js');
    await setTest(true);
    await claimWorkItem(root, 'TASK-204', 'bob');

    await expect(verifyWorkItem(root, 'TASK-204', { actor: 'alice' })).rejects.toThrow(
      /claimed by "bob"/,
    );
  }, 180_000);

  it('lets the holder proceed', async () => {
    await writeCard('TASK-205', 'node test.js', 'test');
    await setTest(true);
    await claimWorkItem(root, 'TASK-205', 'alice');
    await verifyWorkItem(root, 'TASK-205', { actor: 'alice' });

    const result = await advanceWorkItem(root, 'TASK-205', { actor: 'alice' });
    expect(result.refusals).toEqual([]);
    expect(result.moved).toBe(true);
  }, 180_000);
});

describe('bypass 4 — the card lying about what "verify" means (v006)', () => {
  it('refuses evidence produced by a command the card no longer declares', async () => {
    // The evaluator's exact move: no code touched, no flag hidden, one line of
    // YAML edited. `verify: node test.js` becomes `verify: exit 0`, re-run
    // verify and advance, and the item reaches `done` with passing evidence
    // while the real suite fails untouched.
    await setTest(false); // the real suite is red the whole way through

    // Point `verify:` at something that proves nothing, and run it. This is a
    // genuine, passing, daemon-produced run — the exploit needs no forgery.
    await writeCard('TASK-300', 'exit 0', 'test');
    const cheap = await verifyWorkItem(root, 'TASK-300');
    expect(cheap.ok).toBe(true);

    // Put the real check back on the card. The item now claims to be gated on a
    // suite that has never passed, backed by evidence from a command that is no
    // longer declared.
    await writeCard('TASK-300', 'node test.js', 'test');

    const after = await advanceWorkItem(root, 'TASK-300');
    expect(after.moved).toBe(false);
    expect(after.refusals.join('\n')).toMatch(/changed after they passed/);
  }, 180_000);

  it('reports a swapped check as unsupported, naming both commands', async () => {
    await writeCard('TASK-301', 'exit 0');
    await verifyWorkItem(root, 'TASK-301');
    await writeCard('TASK-301', 'node test.js', 'done');
    await setTest(false);

    const attested = await attestationOf('TASK-301');
    expect(attested.attestation).toBe('unsupported');
    expect(attested.concern).toMatch(/The check changed after it passed/);
    expect(attested.concern).toMatch(/exit 0/);
  }, 180_000);
});

describe('stale is not the same claim as unsupported (v006)', () => {
  it('flags an honest item whose tree moved as stale, not unsupported', async () => {
    // The evaluation got this exactly backwards: an honestly-finished item was
    // flagged `unsupported` because an *unrelated* task's file changed the
    // shared tree, while a fabricated one stayed `supported`. The louder warning
    // landed on the honest work.
    await writeCard('TASK-302', 'node test.js');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-302');
    await writeCard('TASK-302', 'node test.js', 'done');
    expect((await attestationOf('TASK-302')).attestation).toBe('supported');

    // Somebody else's file lands in the same workspace.
    await fs.writeFile(path.join(root, 'unrelated.js'), '// somebody else\n', 'utf8');

    const after = await attestationOf('TASK-302');
    expect(after.attestation).toBe('stale');
    expect(after.concern).toMatch(/to confirm it still does/);
  }, 180_000);

  it('will not reopen honest work merely because the tree moved', async () => {
    await writeCard('TASK-303', 'node test.js');
    await setTest(true);
    await verifyWorkItem(root, 'TASK-303');
    await writeCard('TASK-303', 'node test.js', 'done');
    await fs.writeFile(path.join(root, 'unrelated.js'), '// somebody else\n', 'utf8');

    const result = await reopenWorkItem(root, 'TASK-303');
    expect(result.reopened).toBe(false);
    // Reopening honest work because someone else edited a file is how a warning
    // stops being read.
    expect(result.reason).toMatch(/not grounds to retract/);
  }, 180_000);
});

describe('bypass 5 — a check that never ran anything (v007)', () => {
  it('refuses a terminal transition on a command with no readable test count', async () => {
    // The fourth way a blind evaluator got to `done`: point `verify:` at a fake
    // command and leave it there. The v006 binding compares evidence to what the
    // card *currently* declares — and here they matched, because the card had
    // simply redefined what "verify" means, permanently.
    await writeCard('TASK-400', 'echo FAKE PASS && exit 0', 'review');
    const verified = await verifyWorkItem(root, 'TASK-400');
    expect(verified.ok).toBe(true); // the command genuinely succeeded
    expect(verified.report).toBe('exit-code-only');

    const result = await advanceWorkItem(root, 'TASK-400');
    expect(result.moved).toBe(false);
    expect(result.refusals.join('\n')).toMatch(/no readable test count/);
  }, 180_000);

  it('lets a real runner through, because now it can be read', async () => {
    // The fix is *seeing more*, not another rule: a real suite produces a real
    // count, so a no-op can no longer borrow its appearance.
    await fs.writeFile(
      path.join(root, 'real.test.js'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => assert.equal(1,1));\n',
      'utf8',
    );
    await writeCard('TASK-401', 'node --test real.test.js', 'review');

    const verified = await verifyWorkItem(root, 'TASK-401');
    expect(
      verified.report,
      `testsRun=${String(verified.testsRun)} — 'exit-code-only' here means the runner ran and nothing could read what it printed`,
    ).toBe('parsed');
    expect(verified.testsRun).toBeGreaterThan(0);

    const result = await advanceWorkItem(root, 'TASK-401');
    expect(result.refusals.join('\n')).not.toMatch(/no readable test count/);
  }, 180_000);

  it('allows an unreadable check only when the card says so out loud', async () => {
    // The escape hatch is a declaration on the card, not a silent default: a
    // genuinely uncountable check is a fact worth stating where a reviewer sees
    // it.
    const dir = path.join(root, 'kanban', '_inbox');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'TASK-402.md'),
      CARD('TASK-402', 'echo FAKE PASS && exit 0', 'review').replace(
        'risk_level: low',
        'risk_level: low\nverify_unparseable: true',
      ),
      'utf8',
    );

    await verifyWorkItem(root, 'TASK-402');
    const result = await advanceWorkItem(root, 'TASK-402');
    expect(result.refusals.join('\n')).not.toMatch(/no readable test count/);
  }, 180_000);
});

describe('a review must have happened, not merely been passed through (v007)', () => {
  it('refuses done when nothing was ever reviewed', async () => {
    // The evaluator satisfied the old guard by running `sdlc advance` and doing
    // nothing else. Passing through a stage and being reviewed are different
    // facts.
    await writeCard('TASK-500', 'node --test real.test.js', 'review');
    await fs.writeFile(
      path.join(root, 'real.test.js'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => assert.equal(1,1));\n',
      'utf8',
    );
    await verifyWorkItem(root, 'TASK-500');

    const result = await advanceWorkItem(root, 'TASK-500');
    expect(result.moved).toBe(false);
    expect(result.refusals.join('\n')).toMatch(/no recorded review/);
  }, 180_000);

  it('accepts done once a human review is on record', async () => {
    await writeCard('TASK-501', 'node --test real.test.js', 'review');
    await fs.writeFile(
      path.join(root, 'real.test.js'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => assert.equal(1,1));\n',
      'utf8',
    );
    await verifyWorkItem(root, 'TASK-501');
    await recordReview(root, 'TASK-501', { actor: 'bob', findings: ['naming in the parser'] });

    const result = await advanceWorkItem(root, 'TASK-501');
    expect(result.refusals.join('\n')).not.toMatch(/no recorded review/);
  }, 180_000);

  it("does not let an agent's review satisfy the gate", async () => {
    // Agents are actors, never approvers. The review is recorded and readable;
    // it just cannot decide.
    await writeCard('TASK-502', 'node --test real.test.js', 'review');
    await fs.writeFile(
      path.join(root, 'real.test.js'),
      'import { test } from "node:test";\nimport assert from "node:assert";\ntest("a", () => assert.equal(1,1));\n',
      'utf8',
    );
    await verifyWorkItem(root, 'TASK-502');
    const recorded = await recordReview(root, 'TASK-502', {
      actor: 'reviewer-bot',
      actorKind: 'agent',
      findings: ['looks fine to me'],
    });
    expect(recorded.gating).toBe(false);

    const result = await advanceWorkItem(root, 'TASK-502');
    expect(result.refusals.join('\n')).toMatch(/no recorded review/);
  }, 180_000);

  it('refuses a self-review by the claim holder', async () => {
    // "No single agent both implements and self-certifies", made mechanical —
    // and it is the check most likely to catch a real problem, because
    // self-review is what actually happens under time pressure.
    await writeCard('TASK-503', 'node test.js', 'review');
    await claimWorkItem(root, 'TASK-503', 'alice');

    await expect(
      recordReview(root, 'TASK-503', { actor: 'alice', findings: ['fine'] }),
    ).rejects.toBeInstanceOf(SelfReviewError);
  }, 180_000);

  it('refuses a self-review even after the lease has lapsed', async () => {
    // Checking the *live* lease would let an implementer wait an hour and then
    // review their own work. Who last held the item is the fact that matters;
    // whether their lease is still running is a different question.
    await writeCard('TASK-505', 'node test.js', 'review');
    await claimWorkItem(root, 'TASK-505', 'alice', 0);

    await expect(
      recordReview(root, 'TASK-505', { actor: 'alice', findings: ['fine'] }),
    ).rejects.toBeInstanceOf(SelfReviewError);
    // ...and somebody else still can.
    await expect(
      recordReview(root, 'TASK-505', { actor: 'bob', findings: ['fine'] }),
    ).resolves.toBeDefined();
  }, 180_000);

  it('requires a reason when a review found nothing', async () => {
    // A reviewer who approves every diff is indistinguishable from one who
    // never ran (the review skill's own HALT-on-zero-findings rule).
    await writeCard('TASK-504', 'node test.js', 'review');
    await expect(recordReview(root, 'TASK-504', { actor: 'bob' })).rejects.toThrow(/must say why/);
    await expect(
      recordReview(root, 'TASK-504', {
        actor: 'bob',
        noFindingsBecause: 'three-line change, covered by an existing test',
      }),
    ).resolves.toBeDefined();
  }, 180_000);
});

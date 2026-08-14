import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveEchoBack, readEchoApproval, recordEchoBack } from './echo.js';
import { advanceWorkItem } from './advance.js';
import { init } from './commands.js';

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
 * P1-LIFE-05 — the echo-back gate, against a real workspace (ADR-0049).
 *
 * The unit tests cover the verdict logic. What matters here is that the gate is
 * actually in the transition path, and that what the human decided lands in
 * files git can diff — decisions are content, not database rows.
 */

const run = promisify(execFile);
let root: string;

const CARD = [
  '---',
  '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
  'id: FEAT-001',
  'kind: feature',
  'title: CSV import',
  'status: Inbox',
  'lifecycle_state: discovery',
  'work_type: feature',
  'preset: standard',
  'risk_level: low',
  'verify: node -e "process.exit(0)"',
  'done:',
  '  - The importer MUST retry three times.',
  'non_goals:',
  '  - multi-currency',
  'created_at: 2026-08-10T00:00:00.000Z',
  'updated_at: 2026-08-10T00:00:00.000Z',
  '---',
  '',
  'body',
  '',
].join('\n');

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-echo-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'), CARD, 'utf8');
}, 60_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

const echo = (over: Record<string, unknown> = {}) => ({
  workItemId: 'FEAT-001',
  understanding: 'Import CSV exported by billing into the ledger.',
  scope: ['CSV parsing'],
  outOfScope: ['multi-currency'],
  assumptions: [],
  questions: [],
  ambiguity: 'low' as const,
  ...over,
});

describe('the gate in the transition path', () => {
  it('refuses to leave discovery with no restatement at all', async () => {
    const result = await advanceWorkItem(root, 'FEAT-001', { actor: 'ana' });
    expect(result.moved).toBe(false);
    expect(result.refusals.some((reason) => reason.startsWith('echo-back:'))).toBe(true);
  }, 60_000);

  it('still refuses when the restatement exists but nobody approved it', async () => {
    await recordEchoBack(root, echo());
    const result = await advanceWorkItem(root, 'FEAT-001', { actor: 'ana' });
    // The agent proposes an understanding; its own confidence authorizes nothing.
    expect(result.refusals.some((reason) => reason.includes('never authorizes proceeding'))).toBe(
      true,
    );
  }, 60_000);

  it('lifts the refusal once a human approved', async () => {
    await recordEchoBack(root, echo());
    await approveEchoBack(root, 'FEAT-001', { actor: 'ana', presence: 'interactive-tty' });
    const result = await advanceWorkItem(root, 'FEAT-001', { actor: 'ana' });
    expect(result.refusals.filter((reason) => reason.startsWith('echo-back:'))).toEqual([]);
  }, 60_000);

  it('does not evaluate the gate after intake is behind us', async () => {
    await fs.writeFile(
      path.join(root, 'kanban', '_inbox', 'FEAT-001.md'),
      CARD.replace('lifecycle_state: discovery', 'lifecycle_state: plan'),
      'utf8',
    );
    const result = await advanceWorkItem(root, 'FEAT-001', { actor: 'ana' });
    // After planning, a misread requirement has already been paid for. Asking
    // here would be ceremony, and ceremony is what trains people to click through.
    expect(result.refusals.filter((reason) => reason.startsWith('echo-back:'))).toEqual([]);
  }, 60_000);
});

describe('approval', () => {
  it('refuses to approve without a human at a terminal', async () => {
    await recordEchoBack(root, echo());
    // The hole this closes: `--as` is a string, so `sdlc echo approve --as agent`
    // used to succeed and write "decided by: agent (human)" into human-loop.md.
    // The one gate that breaks the agent-approves-its-own-understanding
    // circularity was satisfiable by the agent. A TTY is a property of the
    // process, not a claim the caller makes about itself.
    await expect(
      approveEchoBack(root, 'FEAT-001', { actor: 'agent', presence: 'unattended' }),
    ).rejects.toThrow(/needs a human at a terminal/);
    // Nothing written, so nothing downstream can read a half-approval as real.
    expect(await readEchoApproval(root, 'FEAT-001')).toBeNull();
  }, 60_000);

  it('does not let an unattended approval unblock the transition', async () => {
    await recordEchoBack(root, echo());
    await approveEchoBack(root, 'FEAT-001', {
      actor: 'agent',
      presence: 'unattended',
    }).catch(() => undefined);

    const result = await advanceWorkItem(root, 'FEAT-001', { actor: 'agent' });
    // The refusal must survive the attempt — a gate that stays shut only until
    // something throws is not a gate.
    expect(result.refusals.some((reason) => reason.startsWith('echo-back:'))).toBe(true);
  }, 60_000);

  it('refuses to record an approval that skipped a question', async () => {
    await recordEchoBack(root, echo({ questions: ['Which currency?'], ambiguity: 'high' }));
    await expect(
      approveEchoBack(root, 'FEAT-001', { actor: 'ana', presence: 'interactive-tty' }),
    ).rejects.toThrow(/unanswered/);
    // And nothing was written, so a later read cannot find a half-approval.
    expect(await readEchoApproval(root, 'FEAT-001')).toBeNull();
  }, 60_000);

  it('refuses to approve an item that never restated anything', async () => {
    await expect(
      approveEchoBack(root, 'FEAT-001', { actor: 'ana', presence: 'interactive-tty' }),
    ).rejects.toThrow(/restate its understanding first/);
  }, 60_000);
});

describe('the durable record (contracts/06)', () => {
  it('writes qna.md before anyone has answered', async () => {
    await recordEchoBack(root, echo({ questions: ['Which currency?'], ambiguity: 'high' }));
    const qna = await fs.readFile(path.join(root, 'docs', '.plan', 'qna.md'), 'utf8');
    // A record that only appears once someone replies loses the case that
    // matters most: an echo-back nobody ever answered.
    expect(qna).toContain('Which currency?');
    expect(qna).toContain('_(unanswered)_');
  }, 60_000);

  it('records the decision and the correction in human-loop.md', async () => {
    await recordEchoBack(root, echo());
    await approveEchoBack(root, 'FEAT-001', {
      actor: 'ana',
      presence: 'interactive-tty',
      decision: 'corrected',
      corrections: ['it is TSV, not CSV'],
    });
    const log = await fs.readFile(path.join(root, 'docs', '.plan', 'human-loop.md'), 'utf8');
    expect(log).toContain('ana (human)');
    expect(log).toContain('TSV');
  }, 60_000);
});

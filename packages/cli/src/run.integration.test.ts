import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { init } from './commands.js';
import { NotRunnableError, runWorkItem } from './run.js';
import type { AgentTransport } from '@sdlc-on-fire/agent-manager';

/**
 * `sdlc run` (P6-SURFACE-11).
 *
 * Against a real workspace and a real database, with only the *transport*
 * faked — because the properties under test are the ones nobody could check
 * before: that a pack lands on disk, that a run row appears, and that a failure
 * still finishes the row.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

/**
 * A workspace with one bug card sitting at its ladder entry.
 *
 * The card is written directly rather than through `sdlc new`, which is inline
 * in `index.ts` and has no callable function — a gap worth noting and not worth
 * refactoring from inside a test for a different command.
 */
async function workspace(stage = 'triage', preset = 'standard'): Promise<string> {
  const root = await fs.realpath(await tempDir('sdlcof-run-'));
  await init(root);
  const dir = path.join(resolveWorkspaceLayout(root).kanbanDir, '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'BUG-001.md'),
    [
      '---',
      'id: BUG-001',
      'kind: bug',
      'title: Export breaks across DST',
      'status: Inbox',
      `lifecycle_state: ${stage}`,
      `preset: ${preset}`,
      'work_type: bug',
      '---',
      '',
      '## Description',
      '',
      'Exporting a range that spans a DST change drops an hour.',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

const OUTPUT = JSON.stringify({
  work_item_id: 'BUG-001',
  reproduces: 'yes',
  steps: ['open the export dialog', 'pick a range spanning a DST change'],
  severity: 'high',
  impact: 'anyone exporting across a DST boundary',
});

const transport =
  (over: Partial<Awaited<ReturnType<AgentTransport>>> = {}): AgentTransport =>
  () =>
    Promise.resolve({
      stdout: `triage_bug_output ${OUTPUT}`,
      stderr: '',
      exitCode: 0,
      usage: { costUsd: 0.014, inputTokens: 900, outputTokens: 60, turns: 3 },
      ...over,
    });

async function runRows(root: string): Promise<Record<string, unknown>[]> {
  const { openWorkspaceDatabase } = await import('./commands.js');
  const { db } = await openWorkspaceDatabase(root);
  try {
    return await db.query<Record<string, unknown>>('SELECT * FROM runs ORDER BY started_at;');
  } finally {
    await db.close();
  }
}

describe('sdlc run', () => {
  it('writes the pack, records the run, and returns the skill output', async () => {
    // Every one of these had a writer with no caller before this command
    // existed: the assembler, the pack store, the run row.
    const root = await workspace();
    const result = await runWorkItem(root, 'BUG-001', { transport: transport() });
    if ('dryRun' in result) throw new Error('expected a real run');

    expect(result.skill).toBe('triage-bug');
    expect(result.stage).toBe('triage');
    expect(result.output['severity']).toBe('high');

    const pack = await fs.readFile(path.join(root, result.contextPackPath), 'utf8');
    expect(pack).toContain('Export breaks across DST');

    const rows = await runRows(root);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['status']).toBe('pass');
    expect(rows[0]?.['skill_id']).toBe('triage-bug');
    // The cost the transport reported, recorded rather than computed.
    expect(Number(rows[0]?.['cost_usd'])).toBeCloseTo(0.014);
    expect(rows[0]?.['context_pack_path']).toBe(result.contextPackPath);
  }, 180_000);

  it('finishes the row with a reason when the agent fails', async () => {
    // The case a run record exists for. A failed run left `running` forever is
    // how "currently running" comes to mean "started at some point".
    const root = await workspace();
    await expect(
      runWorkItem(root, 'BUG-001', {
        transport: transport({ stdout: 'I had a look and it seems fine.' }),
      }),
    ).rejects.toThrow();

    const rows = await runRows(root);
    expect(rows[0]?.['status']).toBe('fail');
    expect(rows[0]?.['failure_reason']).toBe('output-contract');
    // The pack still exists: what the agent was asked is the first thing anybody
    // wants when the answer was wrong.
    expect(rows[0]?.['context_pack_path']).toBeTruthy();
  }, 180_000);

  it('assembles and persists on a dry run, and records nothing', async () => {
    // A dry run that assembled a different pack than the real one would answer
    // nothing. A dry run that wrote a row would make the table untrustworthy.
    const root = await workspace();
    const result = await runWorkItem(root, 'BUG-001', { dryRun: true });
    if (!('dryRun' in result)) throw new Error('expected a dry run');

    await expect(fs.stat(path.join(root, result.contextPackPath))).resolves.toBeTruthy();
    expect(await runRows(root)).toEqual([]);
  }, 180_000);

  it('refuses a stage no skill drives, naming the stage', async () => {
    // `test` dispatches no agent — the daemon runs verify. Refusing is the whole
    // point: dispatching "the nearest skill that exists" would route around the
    // gate.
    const root = await workspace();
    const card = path.join(root, 'kanban', '_inbox', 'BUG-001.md');
    const raw = await fs.readFile(card, 'utf8');
    await fs.writeFile(
      card,
      raw.replace('lifecycle_state: triage', 'lifecycle_state: test'),
      'utf8',
    );

    await expect(runWorkItem(root, 'BUG-001', { transport: transport() })).rejects.toBeInstanceOf(
      NotRunnableError,
    );
  }, 120_000);

  it('never overwrites the pack of a run id that already has one', async () => {
    // The file is evidence of what was actually sent. Rewriting it for a re-run
    // under the same id makes the record disagree with what happened, in the
    // direction of whatever ran most recently.
    const root = await workspace();
    const first = await runWorkItem(root, 'BUG-001', {
      transport: transport(),
      runId: 'fixed-run-id',
    });
    const original = await fs.readFile(path.join(root, first.contextPackPath), 'utf8');

    await runWorkItem(root, 'BUG-001', { transport: transport(), runId: 'fixed-run-id' }).catch(
      () => undefined,
    );
    expect(await fs.readFile(path.join(root, first.contextPackPath), 'utf8')).toBe(original);
  }, 240_000);
});

describe('adversarial diversity (P6-SURFACE-09)', () => {
  const REVIEW_OUTPUT = JSON.stringify({
    work_item_id: 'BUG-001',
    findings: [
      {
        severity: 'minor',
        file: 'src/export.ts',
        summary: 'the DST branch is untested',
        rationale: 'nothing exercises the hour that repeats, which is the whole defect',
      },
    ],
    handoff: { openQuestions: [] },
  });

  it('refuses to let a model review what it already worked on', async () => {
    // A RE-REVIEW after changes: the card goes back through `review`, and the
    // model that reviewed it the first time would otherwise review it again and
    // agree with itself for the reasons it missed something the first time.
    //
    // Verified against real run rows, not a mock. The exclusion set comes from
    // what actually ran; asking the config would answer what is *supposed* to
    // run, and the two differ exactly when a fallback fired.
    //
    // Two scenarios deliberately NOT used here. One model for every tier is
    // already refused by the config schema — "a tier that is not a different
    // model is a label, not a capability level" — a better guard that fires
    // first. And `security_review` → `review` would have been the canonical
    // case, except no skill claims the `security_review` STAGE at all: the
    // security-review skill is situational. Filed as P6-SURFACE-15.
    const root = await workspace('review');
    await runWorkItem(root, 'BUG-001', {
      transport: transport({ stdout: `review_output ${REVIEW_OUTPUT}` }),
    });

    // The model that ran, read back from the row rather than assumed. The
    // exclusion set is built from these, so a row with no model would make the
    // guard vacuous and this assertion is what notices.
    const [row] = await runRows(root);
    expect(typeof row?.['model']).toBe('string');

    await expect(
      runWorkItem(root, 'BUG-001', {
        transport: transport({ stdout: `review_output ${REVIEW_OUTPUT}` }),
      }),
    ).rejects.toThrow(/not a second opinion/);
  }, 240_000);

  it('lets a non-adversarial stage reuse the same model', async () => {
    // Diversity is enforced where a second opinion is the point, and nowhere
    // else. Applying it to `implement` would refuse to let one model do two
    // pieces of work on a card, which is not a property anybody wants.
    const root = await workspace();
    await runWorkItem(root, 'BUG-001', { transport: transport() });
    await expect(runWorkItem(root, 'BUG-001', { transport: transport() })).resolves.toBeTruthy();
  }, 240_000);
});

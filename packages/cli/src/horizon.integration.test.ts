import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { formatHorizon, horizonReport, recordTurn } from './horizon.js';

/**
 * Per-turn context accounting against real PGlite (P7-HORIZON-01).
 *
 * The claim under test is that accumulation survives the run — every context
 * number this product had was per-window, and a per-window number is the one
 * shape of measurement guaranteed to look healthy on the runs worth worrying
 * about.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

async function seedRun(runId: string, workItemId = 'TASK-001'): Promise<void> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await port.upsertWorkItem({
      id: workItemId,
      type: 'task',
      title: 'Long run',
      status: 'In Progress',
      lifecycleState: 'implement',
      filePath: `kanban/_inbox/${workItemId}.md`,
      contentHash: 'a'.repeat(64),
    });
    await port.startRun({
      id: runId,
      workItemId,
      skillId: 'implement',
      startedAt: '2026-08-30T00:00:00.000Z',
    });
  } finally {
    await db.close();
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'horizon-')));
  await init(root, { database: 'skip' });
  await seedRun('run-1');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('recording turns', () => {
  it('records one turn', async () => {
    const result = await recordTurn(root, {
      runId: 'run-1',
      turn: 1,
      inputTokens: 1000,
      outputTokens: 200,
    });
    expect(result.recorded).toBe(true);
  }, 180_000);

  it('does not let a retry rewrite a turn that already happened', async () => {
    await recordTurn(root, { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 200 });
    const second = await recordTurn(root, {
      runId: 'run-1',
      turn: 1,
      inputTokens: 99_999,
      outputTokens: 0,
    });
    expect(second.recorded).toBe(false);

    const report = await horizonReport(root, { runId: 'run-1' });
    expect(report.accounts[0]?.accumulated).toBe(1200);
  }, 180_000);
});

describe('the report', () => {
  it('says what is missing when nothing has been recorded', async () => {
    const report = await horizonReport(root);
    expect(report.accounts).toEqual([]);
    expect(formatHorizon(report)).toContain('every window looks fine');
  }, 180_000);

  it('accumulates across turns, cache reads included', async () => {
    await recordTurn(root, {
      runId: 'run-1',
      turn: 1,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 40_000,
    });
    await recordTurn(root, {
      runId: 'run-1',
      turn: 2,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 40_000,
    });

    const report = await horizonReport(root);
    const account = report.accounts[0];
    expect(account?.accumulatedInput).toBe(82_000);
    expect(account?.accumulated).toBe(82_200);
    // Cheap, and therefore easy to leave running — which is the point.
    expect(account?.cachedFraction).toBeCloseTo(0.976, 2);
  }, 180_000);

  it('shows a long run whose every window looked fine', async () => {
    for (let turn = 1; turn <= 20; turn += 1) {
      await recordTurn(root, { runId: 'run-1', turn, inputTokens: 5000, outputTokens: 0 });
    }
    const report = await horizonReport(root);
    expect(report.accounts[0]?.turns).toBe(20);
    expect(report.accounts[0]?.peakTurn).toBe(5000);
    expect(report.worstBlindnessRatio).toBe(20);
    expect(formatHorizon(report)).toContain('worst window blindness');
  }, 180_000);

  it('reports the worst blindness across runs, not the best', async () => {
    // With one run the max and the min are the same number, and the report
    // would look right while naming whichever run flattered it.
    await seedRun('run-2', 'TASK-002');
    await recordTurn(root, { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 0 });
    for (let turn = 1; turn <= 5; turn += 1) {
      await recordTurn(root, { runId: 'run-2', turn, inputTokens: 1000, outputTokens: 0 });
    }
    const report = await horizonReport(root);
    expect(report.worstBlindnessRatio).toBe(5);
  }, 180_000);

  it('groups by run', async () => {
    await seedRun('run-2', 'TASK-002');
    await recordTurn(root, { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 0 });
    await recordTurn(root, { runId: 'run-2', turn: 1, inputTokens: 2000, outputTokens: 0 });

    const report = await horizonReport(root);
    expect(report.accounts.map((a) => a.runId)).toEqual(['run-1', 'run-2']);
    expect(report.accounts[1]?.accumulated).toBe(2000);
  }, 180_000);

  it('scopes to one run when asked', async () => {
    await seedRun('run-2', 'TASK-002');
    await recordTurn(root, { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 0 });
    await recordTurn(root, { runId: 'run-2', turn: 1, inputTokens: 2000, outputTokens: 0 });

    const report = await horizonReport(root, { runId: 'run-2' });
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]?.runId).toBe('run-2');
  }, 180_000);

  it('reports growth once there are two turns to compare', async () => {
    await recordTurn(root, { runId: 'run-1', turn: 1, inputTokens: 1000, outputTokens: 0 });
    expect((await horizonReport(root)).accounts[0]?.growthPerTurn).toBeNull();

    await recordTurn(root, { runId: 'run-1', turn: 2, inputTokens: 3000, outputTokens: 0 });
    expect((await horizonReport(root)).accounts[0]?.growthPerTurn).toBe(2000);
  }, 180_000);
});

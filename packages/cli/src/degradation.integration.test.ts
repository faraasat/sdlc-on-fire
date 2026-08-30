import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { compactRun, degradationReport, formatDegradationReport, recordTurn } from './horizon.js';

/**
 * The degradation signal against real PGlite (P7-HORIZON-03).
 *
 * Surfaced rather than inferred from bad output, which is the worst possible
 * detector: a long run stays fluent as it degrades, and what changes is that it
 * stops being about the task.
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

async function setBudget(tokens: number): Promise<void> {
  const configPath = path.join(root, '.sdlcof', 'config.yaml');
  const config = await fs.readFile(configPath, 'utf8');
  const withoutContext = config.replace(/\ncontext:\n(?: {2}.*\n)*/g, '\n');
  await fs.writeFile(
    configPath,
    `${withoutContext.trimEnd()}\ncontext:\n  run_budget_tokens: ${String(tokens)}\n`,
    'utf8',
  );
}

async function longRun(runId: string, turnCount: number, each = 1000): Promise<void> {
  for (let turn = 1; turn <= turnCount; turn += 1) {
    await recordTurn(root, { runId, turn, inputTokens: each, outputTokens: 0 });
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'degrade-')));
  await init(root, { database: 'skip' });
  await seedRun('run-1');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('assessing runs', () => {
  it('has nothing to assess before any accounting', async () => {
    const report = await degradationReport(root);
    expect(report.verdicts).toEqual([]);
    expect(formatDegradationReport(report)).toContain('nothing to assess');
  }, 180_000);

  it('reports a short run as ok', async () => {
    await setBudget(1_000_000);
    await longRun('run-1', 5);
    const report = await degradationReport(root);
    expect(report.degraded).toEqual([]);
    expect(report.verdicts[0]?.measured).toBe(true);
  }, 180_000);

  it('flags a run over its declared ceiling', async () => {
    await setBudget(10_000);
    await longRun('run-1', 20);
    const report = await degradationReport(root);
    expect(report.degraded).toEqual(['run-1']);
    expect(report.verdicts[0]?.fired.map((f) => f.signal)).toContain('over-budget');
  }, 180_000);

  it('flags a run that has been compacted repeatedly', async () => {
    await setBudget(10_000);
    await longRun('run-1', 20);
    for (let n = 0; n < 4; n += 1) {
      await compactRun(root, 'run-1', {
        apply: true,
        firedAt: `2026-08-30T0${String(n + 1)}:00:00.000Z`,
      });
    }
    const report = await degradationReport(root);
    expect(report.verdicts[0]?.fired.map((f) => f.signal)).toContain('repeatedly-compacted');
  }, 180_000);

  it('flags a long run even with a generous ceiling', async () => {
    await setBudget(100_000_000);
    await longRun('run-1', 45, 10);
    const report = await degradationReport(root);
    expect(report.verdicts[0]?.fired.map((f) => f.signal)).toEqual(['turn-count']);
  }, 180_000);

  it('scopes to one run when asked', async () => {
    await seedRun('run-2', 'TASK-002');
    await setBudget(10_000);
    await longRun('run-1', 20);
    await longRun('run-2', 2);

    const all = await degradationReport(root);
    expect(all.verdicts).toHaveLength(2);
    expect(all.degraded).toEqual(['run-1']);

    const scoped = await degradationReport(root, { runId: 'run-2' });
    expect(scoped.verdicts).toHaveLength(1);
    expect(scoped.degraded).toEqual([]);
  }, 180_000);
});

describe('runs where the accounting itself failed', () => {
  it('reports a compacted run with no turn rows as unmeasured, not healthy', async () => {
    // These are the runs most worth looking at, so dropping them would hide
    // exactly the wrong ones.
    await setBudget(10_000);
    await longRun('run-1', 20);
    await compactRun(root, 'run-1', { apply: true });

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      await db.query('DELETE FROM run_turns WHERE run_id = $1;', ['run-1']);
    } finally {
      await db.close();
    }

    const report = await degradationReport(root);
    expect(report.unmeasured).toEqual(['run-1']);
    expect(report.degraded).toEqual([]);
    expect(formatDegradationReport(report)).toContain('unmeasured');
  }, 180_000);
});

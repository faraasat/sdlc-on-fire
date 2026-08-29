import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { formatRuns, runHistory, DEFAULT_RUN_LIMIT } from './runs.js';

/**
 * `sdlc runs` against real PGlite (P6-SURFACE-07, FEAT-STORE-020).
 *
 * `sdlc metrics agents` aggregates the same rows. What a person actually
 * arrives with is "what happened on this card, in order" — a p95 cannot say
 * that the third attempt broke its output contract and the fourth one worked.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

async function seed(
  runs: readonly {
    id: string;
    workItemId: string;
    status?: string;
    failureReason?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number; turns?: number };
  }[],
  items: readonly { id: string; title: string }[],
): Promise<void> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    for (const item of items) {
      await port.upsertWorkItem({
        id: item.id,
        type: 'task',
        title: item.title,
        status: 'In Progress',
        lifecycleState: 'implement',
        filePath: `kanban/_inbox/${item.id}.md`,
        contentHash: 'e'.repeat(64),
      });
    }
    for (const run of runs) {
      await port.startRun({
        id: run.id,
        workItemId: run.workItemId,
        skillId: 'implement',
        model: 'claude-sonnet-5',
        contextPackPath: `.sdlc/context/packs/${run.id}.md`,
        startedAt: run.startedAt ?? '2026-08-30T00:00:00.000Z',
      });
      if (run.status !== undefined && run.status !== 'running') {
        await port.finishRun({
          id: run.id,
          status: run.status as 'pass' | 'fail' | 'error',
          finishedAt: run.finishedAt ?? '2026-08-30T00:00:30.000Z',
          ...(run.failureReason == null ? {} : { failureReason: run.failureReason }),
          ...(run.usage === undefined ? {} : { usage: run.usage }),
        } as Parameters<typeof port.finishRun>[0]);
      }
    }
  } finally {
    await db.close();
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'runs-')));
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('the history', () => {
  it('is empty, and says so, before anything has run', async () => {
    const history = await runHistory(root);
    expect(history.runs).toEqual([]);
    expect(formatRuns(history)).toContain('no runs recorded');
  }, 180_000);

  it('joins each run to its work item', async () => {
    await seed(
      [{ id: 'r1', workItemId: 'TASK-001', status: 'pass' }],
      [{ id: 'TASK-001', title: 'Escape commas' }],
    );
    const history = await runHistory(root);
    // A run id is a string nobody recognises; the title is what makes it a
    // history rather than a log.
    expect(history.runs[0]?.workItemTitle).toBe('Escape commas');
  }, 180_000);

  it('orders newest first', async () => {
    await seed(
      [
        {
          id: 'old',
          workItemId: 'TASK-001',
          status: 'pass',
          startedAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 'new',
          workItemId: 'TASK-001',
          status: 'pass',
          startedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
      [{ id: 'TASK-001', title: 'T' }],
    );
    expect((await runHistory(root)).runs.map((r) => r.id)).toEqual(['new', 'old']);
  }, 180_000);

  it('filters to one work item', async () => {
    await seed(
      [
        { id: 'a', workItemId: 'TASK-001', status: 'pass' },
        { id: 'b', workItemId: 'TASK-002', status: 'pass' },
      ],
      [
        { id: 'TASK-001', title: 'One' },
        { id: 'TASK-002', title: 'Two' },
      ],
    );
    const history = await runHistory(root, { workItemId: 'TASK-002' });
    expect(history.runs.map((r) => r.id)).toEqual(['b']);
    expect(history.total).toBe(1);
  }, 180_000);

  it('filters by status', async () => {
    await seed(
      [
        { id: 'p', workItemId: 'TASK-001', status: 'pass' },
        { id: 'f', workItemId: 'TASK-001', status: 'fail', failureReason: 'output-contract' },
      ],
      [{ id: 'TASK-001', title: 'T' }],
    );
    const failures = await runHistory(root, { status: 'fail' });
    expect(failures.runs.map((r) => r.id)).toEqual(['f']);
    expect(failures.runs[0]?.failureReason).toBe('output-contract');
  }, 180_000);

  it('reports the total behind a limit rather than truncating quietly', async () => {
    await seed(
      Array.from({ length: 5 }, (_, i) => ({
        id: `r${String(i)}`,
        workItemId: 'TASK-001',
        status: 'pass',
        startedAt: `2026-08-0${String(i + 1)}T00:00:00.000Z`,
      })),
      [{ id: 'TASK-001', title: 'T' }],
    );
    const history = await runHistory(root, { limit: 2 });
    expect(history.runs).toHaveLength(2);
    expect(history.total).toBe(5);
    expect(formatRuns(history)).toContain('showing 2 of 5');
  }, 180_000);

  it('defaults to a bounded page', async () => {
    expect(DEFAULT_RUN_LIMIT).toBe(20);
    expect((await runHistory(root)).limit).toBe(20);
  }, 180_000);
});

describe('what the rows say', () => {
  it('computes duration from the two timestamps', async () => {
    await seed(
      [
        {
          id: 'r1',
          workItemId: 'TASK-001',
          status: 'pass',
          startedAt: '2026-08-30T00:00:00.000Z',
          finishedAt: '2026-08-30T00:00:45.000Z',
        },
      ],
      [{ id: 'TASK-001', title: 'T' }],
    );
    expect((await runHistory(root)).runs[0]?.durationMs).toBe(45_000);
  }, 180_000);

  it('has no duration for a run that never finished', async () => {
    await seed(
      [{ id: 'r1', workItemId: 'TASK-001', status: 'running' }],
      [{ id: 'TASK-001', title: 'T' }],
    );
    const run = (await runHistory(root)).runs[0];
    expect(run?.durationMs).toBeNull();
    // Reported exactly as stored. A history that tidied a stuck row on read
    // would hide the rows worth looking at.
    expect(run?.status).toBe('running');
  }, 180_000);

  it('distinguishes "cost not reported" from a free run', async () => {
    await seed(
      [
        { id: 'silent', workItemId: 'TASK-001', status: 'pass' },
        {
          id: 'priced',
          workItemId: 'TASK-001',
          status: 'pass',
          startedAt: '2026-08-29T00:00:00.000Z',
          usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.0125, turns: 3 },
        },
      ],
      [{ id: 'TASK-001', title: 'T' }],
    );
    const byId = new Map((await runHistory(root)).runs.map((r) => [r.id, r]));
    expect(byId.get('silent')?.costUsd).toBeNull();
    expect(byId.get('priced')?.costUsd).toBeCloseTo(0.0125, 6);
    expect(byId.get('priced')?.turns).toBe(3);
    expect(formatRuns(await runHistory(root))).toContain('cost not reported');
  }, 180_000);

  it('carries the context pack path, so the pack is findable from the history', async () => {
    await seed(
      [{ id: 'r1', workItemId: 'TASK-001', status: 'pass' }],
      [{ id: 'TASK-001', title: 'T' }],
    );
    expect((await runHistory(root)).runs[0]?.contextPackPath).toBe('.sdlc/context/packs/r1.md');
  }, 180_000);
});

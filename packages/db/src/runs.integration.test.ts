import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { provisionPglite } from './pglite.js';
import { applySchema } from './migrate.js';
import { PostgresStorageAdapter } from './postgres-adapter.js';

/**
 * Run rows, written for the first time (P6-WRITEPATH-01).
 *
 * The table, its CHECK constraint and `/api/runs` all shipped in the first
 * migration. Nothing ever inserted a row, so every invariant the schema
 * declares had been enforced against zero data.
 */
async function fresh() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-runs-'));
  const db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  const port = await PostgresStorageAdapter.create(db);
  // `runs.work_item_id` is a foreign key. A run belongs to a work item or it
  // is not a run of anything — which is also why the recorder at the dispatch
  // site is wrapped so a failed write cannot take the actual work down.
  await port.upsertWorkItem({
    id: 'TASK-1',
    type: 'task',
    title: 'A task',
    status: 'todo',
    lifecycleState: 'implement',
    workType: 'feature',
    preset: 'standard',
    riskLevel: 'low',
    parentId: null,
    filePath: 'kanban/_inbox/TASK-1.md',
    contentHash: 'abc',
  });
  return { db, port };
}

const START = {
  id: 'run-1',
  workItemId: 'TASK-1',
  skillId: 'implement',
  agentTarget: 'claude-code',
  model: 'claude-opus-5',
  contextPackPath: '.sdlc/context/packs/run-1.md',
  startedAt: '2026-08-23T10:00:00.000Z',
};

describe('run rows', () => {
  it('writes a row that /api/runs can actually read', async () => {
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      const rows = await db.query<Record<string, unknown>>('SELECT * FROM runs;');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 'run-1',
        work_item_id: 'TASK-1',
        skill_id: 'implement',
        agent_target: 'claude-code',
        model: 'claude-opus-5',
        status: 'running',
      });
    } finally {
      await db.close();
    }
  }, 90_000);

  it('a finish moves it to a terminal status with a time', async () => {
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.finishRun({ id: 'run-1', status: 'pass', finishedAt: '2026-08-23T10:05:00.000Z' });
      const [row] = await db.query<{ status: string; finished_at: Date | string }>(
        'SELECT status, finished_at FROM runs WHERE id = $1;',
        ['run-1'],
      );
      expect(row?.status).toBe('pass');
      expect(row?.finished_at).not.toBeNull();
    } finally {
      await db.close();
    }
  }, 90_000);

  it('a repeated start does not reset started_at', async () => {
    // A run id is minted once per dispatch, so a second start is a retry of the
    // *write*. Overwriting would silently shorten a run that had been going an
    // hour into one that just began.
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.startRun({ ...START, startedAt: '2026-08-23T23:00:00.000Z' });
      const rows = await db.query<{ started_at: Date }>('SELECT started_at FROM runs;');
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]!.started_at).toISOString()).toBe('2026-08-23T10:00:00.000Z');
    } finally {
      await db.close();
    }
  }, 90_000);

  it('a late finish cannot rewrite a run that already ended', async () => {
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.finishRun({ id: 'run-1', status: 'fail', finishedAt: '2026-08-23T10:05:00.000Z' });
      await port.finishRun({ id: 'run-1', status: 'pass', finishedAt: '2026-08-23T10:09:00.000Z' });
      const [row] = await db.query<{ status: string }>('SELECT status FROM runs WHERE id = $1;', [
        'run-1',
      ]);
      // A run that reached a terminal status does not change again.
      expect(row?.status).toBe('fail');
    } finally {
      await db.close();
    }
  }, 90_000);

  it('the CHECK constraint rejects a status the vocabulary does not have', async () => {
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await expect(
        db.query("UPDATE runs SET status = 'finished-ish' WHERE id = 'run-1';"),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  }, 90_000);

  it('finishing a run that was never started changes nothing', async () => {
    const { db, port } = await fresh();
    try {
      await port.finishRun({ id: 'ghost', status: 'pass', finishedAt: '2026-08-23T10:05:00.000Z' });
      expect(await db.query('SELECT * FROM runs;')).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 90_000);
});

describe('run usage and failure reasons (P6-INSTRUMENT-02)', () => {
  it('records what the transport reported, and NULL when it reported nothing', async () => {
    // The one confusion the nullable columns exist to prevent: a cost of 0
    // because nothing was recorded and one because nothing was spent look
    // identical in a report, and one of them is wrong.
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.finishRun({
        id: 'run-1',
        status: 'pass',
        finishedAt: '2026-08-24T10:05:00.000Z',
        usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0431 },
      });
      await port.startRun({ ...START, id: 'run-2' });
      await port.finishRun({ id: 'run-2', status: 'pass', finishedAt: '2026-08-24T10:06:00.000Z' });

      const rows = await db.query<{
        id: string;
        input_tokens: number | null;
        cost_usd: string | null;
      }>('SELECT id, input_tokens, cost_usd FROM runs ORDER BY id;');
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get('run-1')?.input_tokens).toBe(1200);
      expect(Number(byId.get('run-1')?.cost_usd)).toBeCloseTo(0.0431);
      expect(byId.get('run-2')?.input_tokens).toBeNull();
      expect(byId.get('run-2')?.cost_usd).toBeNull();
    } finally {
      await db.close();
    }
  }, 90_000);

  it('refuses a failure reason outside the vocabulary', async () => {
    // The column's whole value is that it can be counted. Free text here would
    // be as uncountable as asking the agent why it failed.
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await expect(
        db.query("UPDATE runs SET failure_reason = 'it got confused' WHERE id = 'run-1';"),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  }, 90_000);

  it('never stores a failure reason on a run that passed', async () => {
    // A reason on a passing run is a contradiction, and it would be counted as a
    // failure by every query that reads the column looking for one.
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.finishRun({
        id: 'run-1',
        status: 'pass',
        finishedAt: '2026-08-24T10:05:00.000Z',
        failureReason: 'transport',
      });
      const [row] = await db.query<{ failure_reason: string | null }>(
        "SELECT failure_reason FROM runs WHERE id = 'run-1';",
      );
      expect(row?.failure_reason).toBeNull();
    } finally {
      await db.close();
    }
  }, 90_000);

  it('stores the reason on a run that failed', async () => {
    const { db, port } = await fresh();
    try {
      await port.startRun(START);
      await port.finishRun({
        id: 'run-1',
        status: 'fail',
        finishedAt: '2026-08-24T10:05:00.000Z',
        failureReason: 'forbidden-claim',
      });
      const [row] = await db.query<{ failure_reason: string | null }>(
        "SELECT failure_reason FROM runs WHERE id = 'run-1';",
      );
      expect(row?.failure_reason).toBe('forbidden-claim');
    } finally {
      await db.close();
    }
  }, 90_000);
});

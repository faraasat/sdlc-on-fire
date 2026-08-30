import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { criteriaStatus, heldOutSamples } from './criteria.js';
import { formatHeldOut, heldOutReport } from './metrics.js';

/**
 * `sdlc metrics held-out` against real PGlite (P7-HELDOUT-02).
 *
 * The per-item delta already existed inside `criteria status`, computed fresh
 * and thrown away. What is new — and what this covers — is that a measurement
 * survives to be compared against the next one.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

async function seedItem(id: string): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.md`),
    [
      '---',
      '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
      `id: ${id}`,
      'kind: task',
      'title: Measured',
      'status: In Progress',
      'lifecycle_state: implement',
      'work_type: task',
      'preset: standard',
      'risk_level: low',
      'created_at: 2026-08-10T00:00:00.000Z',
      'updated_at: 2026-08-10T00:00:00.000Z',
      '---',
      '',
      'body',
      '',
    ].join('\n'),
    'utf8',
  );

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await port.upsertWorkItem({
      id,
      type: 'task',
      title: 'Measured',
      status: 'In Progress',
      lifecycleState: 'implement',
      filePath: `kanban/_inbox/${id}.md`,
      contentHash: 'a'.repeat(64),
    });
  } finally {
    await db.close();
  }
}

async function record(
  id: string,
  visiblePassed: number,
  heldOutPassed: number,
  day: number,
): Promise<void> {
  await criteriaStatus(root, id, {
    visible: Array.from({ length: 10 }, (_, i) => ({
      id: `v${String(i)}`,
      passed: i < visiblePassed,
    })),
    heldOut: Array.from({ length: 10 }, (_, i) => ({
      id: `h${String(i)}`,
      passed: i < heldOutPassed,
    })),
    record: true,
    measuredAt: `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  });
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ho-metrics-')));
  await init(root, { database: 'skip' });
  await seedItem('TASK-001');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('recording', () => {
  it('does not record unless asked', async () => {
    const status = await criteriaStatus(root, 'TASK-001', {
      visible: [{ id: 'v', passed: true }],
      heldOut: [{ id: 'h', passed: false }],
    });
    expect(status.recorded).toBe(false);
    // Otherwise the trend becomes a record of how often somebody ran the report.
    expect(await heldOutSamples(root, 'TASK-001')).toEqual([]);
  }, 180_000);

  it('appends a measurement when asked', async () => {
    await record('TASK-001', 9, 5, 1);
    const samples = await heldOutSamples(root, 'TASK-001');
    expect(samples).toHaveLength(1);
    expect(samples[0]?.deltaPp).toBe(40);
    expect(samples[0]?.visibleTotal).toBe(10);
  }, 180_000);

  it('appends rather than replacing', async () => {
    await record('TASK-001', 9, 5, 1);
    await record('TASK-001', 9, 3, 2);
    expect(await heldOutSamples(root, 'TASK-001')).toHaveLength(2);
  }, 180_000);

  it('stores an unmeasured delta as NULL, not as zero', async () => {
    // "They agree" and "nothing was held out" must stay distinguishable.
    await criteriaStatus(root, 'TASK-001', {
      visible: [{ id: 'v', passed: true }],
      record: true,
    });
    const samples = await heldOutSamples(root, 'TASK-001');
    expect(samples[0]?.deltaPp).toBeNull();
  }, 180_000);
});

describe('the report', () => {
  it('says there is nothing yet, and how to get something', async () => {
    const report = await heldOutReport(root);
    expect(report.items).toEqual([]);
    expect(formatHeldOut(report)).toContain('--record');
  }, 180_000);

  it('flags a widening gap by item', async () => {
    await record('TASK-001', 9, 8, 1);
    await record('TASK-001', 9, 2, 2);

    const report = await heldOutReport(root);
    expect(report.widening).toEqual(['TASK-001']);
    expect(report.items[0]?.trend.direction).toBe('widening');
    expect(report.items[0]?.latestDeltaPp).toBe(70);
    expect(formatHeldOut(report)).toContain('⚠');
  }, 180_000);

  it('does not flag a narrowing one', async () => {
    await record('TASK-001', 9, 2, 1);
    await record('TASK-001', 9, 8, 2);
    const report = await heldOutReport(root);
    expect(report.widening).toEqual([]);
    expect(report.items[0]?.trend.direction).toBe('narrowing');
  }, 180_000);

  it('counts measured and unmeasured items separately', async () => {
    await seedItem('TASK-002');
    await record('TASK-001', 9, 5, 1);
    await criteriaStatus(root, 'TASK-002', {
      visible: [{ id: 'v', passed: true }],
      record: true,
    });

    const report = await heldOutReport(root);
    // On most workspaces nearly every item is unmeasured. A report that omitted
    // them would show a confident gap over the three somebody happened to measure.
    expect(report.measuredItems).toBe(1);
    expect(report.unmeasuredItems).toBe(1);
    expect(formatHeldOut(report)).toContain('unmeasured');
  }, 180_000);

  it('reports a workspace-wide trend beside the per-item ones', async () => {
    await record('TASK-001', 9, 8, 1);
    await record('TASK-001', 9, 2, 2);
    const report = await heldOutReport(root);
    expect(report.overall.direction).toBe('widening');
    expect(report.overall.measuredSamples).toBe(2);
  }, 180_000);

  it('is unmeasured overall from a single sample', async () => {
    await record('TASK-001', 9, 5, 1);
    expect((await heldOutReport(root)).overall.direction).toBe('unmeasured');
  }, 180_000);
});

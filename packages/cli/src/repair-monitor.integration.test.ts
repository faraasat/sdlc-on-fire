import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestInventory } from '@sdlc-on-fire/evidence';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { formatMonitorReport, gradeRepair, repairMonitorReport } from './repair-monitor.js';

/**
 * Grading the repair monitor against real PGlite (P7-HELDOUT-03).
 *
 * `repairIsLegitimate` is run here from the inventories rather than taking a
 * verdict a caller supplies — a grade whose "what the monitor said" half came
 * from the thing being graded would measure nothing.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

const inventory = (over: Partial<TestInventory> = {}): TestInventory => ({
  files: ['a.test.ts', 'b.test.ts'],
  cases: 20,
  assertions: 40,
  ...over,
});

/** A repair that deleted a test file — the monitor must refuse this. */
const shrunk = (): TestInventory => inventory({ files: ['a.test.ts'], cases: 12 });

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
      'title: Repaired',
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
      title: 'Repaired',
      status: 'In Progress',
      lifecycleState: 'implement',
      filePath: `kanban/_inbox/${id}.md`,
      contentHash: 'a'.repeat(64),
    });
  } finally {
    await db.close();
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repair-')));
  await init(root, { database: 'skip' });
  await seedItem('TASK-001');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('grading one repair', () => {
  it('is caught when the monitor refused and the held-out suite agreed', async () => {
    const result = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: shrunk(),
      heldOutPassed: false,
    });
    expect(result.monitorLegitimate).toBe(false);
    expect(result.cell).toBe('caught');
    expect(result.reasons.join(' ')).toContain('b.test.ts');
    expect(result.recorded).toBe(true);
  }, 180_000);

  it('is missed when the monitor accepted a repair the held-out suite rejected', async () => {
    // The suite did not shrink at all, so the monitor has nothing to object to
    // — and the held-out tests still fail. This is the expensive cell.
    const result = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: inventory(),
      heldOutPassed: false,
    });
    expect(result.monitorLegitimate).toBe(true);
    expect(result.cell).toBe('missed');
  }, 180_000);

  it('is over-blocked when it refused a repair the held-out suite passed', async () => {
    const result = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: shrunk(),
      heldOutPassed: true,
    });
    expect(result.cell).toBe('over-blocked');
  }, 180_000);

  it('is cleared when both agreed the repair was real', async () => {
    const result = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: inventory({ cases: 24 }),
      heldOutPassed: true,
    });
    expect(result.cell).toBe('cleared');
    expect(result.reasons).toEqual([]);
  }, 180_000);

  it('grades an attempt once — the first grade stands', async () => {
    await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: shrunk(),
      heldOutPassed: false,
    });
    const second = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: inventory(),
      heldOutPassed: true,
    });
    expect(second.recorded).toBe(false);

    // And the stored grade is still the first one.
    const report = await repairMonitorReport(root);
    expect(report.observations).toBe(1);
    expect(report.caught).toBe(1);
  }, 180_000);
});

describe('the report', () => {
  it('is unmeasured before anything is graded', async () => {
    const report = await repairMonitorReport(root);
    expect(report.observations).toBe(0);
    expect(report.precision).toBeNull();
    expect(formatMonitorReport(report)).toContain('unmeasured');
  }, 180_000);

  it('accumulates across attempts', async () => {
    await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: shrunk(),
      heldOutPassed: false,
    });
    await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 2,
      before: inventory(),
      after: inventory(),
      heldOutPassed: false,
    });

    const report = await repairMonitorReport(root);
    expect(report.observations).toBe(2);
    expect(report.caught).toBe(1);
    expect(report.missed).toBe(1);
    expect(report.recall).toBe(50);
    expect(formatMonitorReport(report)).toContain('expensive');
  }, 180_000);

  it('scopes to one work item when asked', async () => {
    await seedItem('TASK-002');
    await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: shrunk(),
      heldOutPassed: false,
    });
    await gradeRepair(root, {
      workItemId: 'TASK-002',
      attempt: 1,
      before: inventory(),
      after: inventory(),
      heldOutPassed: false,
    });

    const scoped = await repairMonitorReport(root, { workItemId: 'TASK-002' });
    expect(scoped.observations).toBe(1);
    expect(scoped.missed).toBe(1);
    expect(scoped.caught).toBe(0);
    expect(formatMonitorReport(scoped)).toContain('TASK-002');
  }, 180_000);

  it('runs the monitor itself rather than trusting a supplied verdict', async () => {
    // The inventories say the suite shrank, so the grade must be a refusal
    // whatever anybody else thinks about the repair.
    const result = await gradeRepair(root, {
      workItemId: 'TASK-001',
      attempt: 1,
      before: inventory(),
      after: inventory({ skipped: 4 }),
      heldOutPassed: true,
    });
    expect(result.monitorLegitimate).toBe(false);
    expect(result.reasons.join(' ')).toContain('skipped');
  }, 180_000);
});

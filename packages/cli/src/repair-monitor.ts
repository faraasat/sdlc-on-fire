import {
  formatRepairScore,
  scoreRepairMonitor,
  type RepairObservation,
  type RepairScore,
} from '@sdlc-on-fire/core';
import { repairIsLegitimate, type TestInventory } from '@sdlc-on-fire/evidence';
import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc repair-monitor` — grading the guard (P7-HELDOUT-03, ADR-0037).
 *
 * `repairIsLegitimate` has been the deterministic disposer for "did this repair
 * fix the code or the scoreboard" since P3-GATE-10, and nothing has ever
 * checked whether it is right. A guard in that position looks fine either way:
 * one that never fires looks like a clean codebase, and one that always fires
 * looks vigilant.
 *
 * The held-out suite is what makes the grade possible, because it is the one
 * verdict the repair could not have been written against.
 */

export interface GradeInput {
  readonly workItemId: string;
  readonly attempt: number;
  readonly before: TestInventory;
  readonly after: TestInventory;
  /** What the held-out suite said about the same repair. */
  readonly heldOutPassed: boolean;
  readonly observedAt?: string | undefined;
}

export interface GradeResult {
  readonly workItemId: string;
  readonly attempt: number;
  readonly monitorLegitimate: boolean;
  readonly heldOutPassed: boolean;
  readonly reasons: readonly string[];
  /** What this attempt turned out to be. */
  readonly cell: 'caught' | 'over-blocked' | 'missed' | 'cleared';
  /** False when an observation for this attempt already existed. */
  readonly recorded: boolean;
}

function cellFor(monitorLegitimate: boolean, heldOutPassed: boolean): GradeResult['cell'] {
  if (!monitorLegitimate) return heldOutPassed ? 'over-blocked' : 'caught';
  return heldOutPassed ? 'cleared' : 'missed';
}

/**
 * Runs the monitor over one repair and records the grade beside the held-out
 * verdict.
 *
 * The monitor is run **here**, from the inventories, rather than accepting a
 * verdict a caller supplies. A grade whose "what the monitor said" half came
 * from the thing being graded would measure nothing.
 */
export async function gradeRepair(root: string, input: GradeInput): Promise<GradeResult> {
  const judgement = repairIsLegitimate(input.before, input.after);
  const cell = cellFor(judgement.legitimate, input.heldOutPassed);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{ id: number }>(
      `INSERT INTO repair_observations
         (work_item_id, attempt, observed_at, monitor_legitimate, held_out_passed, reasons)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6::jsonb)
       ON CONFLICT (work_item_id, attempt) DO NOTHING
       RETURNING id;`,
      [
        input.workItemId,
        input.attempt,
        input.observedAt ?? null,
        judgement.legitimate,
        input.heldOutPassed,
        JSON.stringify(judgement.reasons),
      ],
    );

    return {
      workItemId: input.workItemId,
      attempt: input.attempt,
      monitorLegitimate: judgement.legitimate,
      heldOutPassed: input.heldOutPassed,
      reasons: judgement.reasons,
      cell,
      // `DO NOTHING` rather than an upsert: a repair attempt is graded once, and
      // the value of the record is that it was written before anybody knew how
      // it would score.
      recorded: rows.length > 0,
    };
  } finally {
    await db.close();
  }
}

export interface MonitorReport extends RepairScore {
  readonly workItemId?: string | undefined;
}

export async function repairMonitorReport(
  root: string,
  options: { readonly workItemId?: string | undefined } = {},
): Promise<MonitorReport> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const params = options.workItemId === undefined ? [] : [options.workItemId];
    const rows = await db.query<{
      work_item_id: string;
      attempt: number;
      observed_at: string;
      monitor_legitimate: boolean;
      held_out_passed: boolean;
    }>(
      `SELECT work_item_id, attempt, observed_at, monitor_legitimate, held_out_passed
         FROM repair_observations
        ${options.workItemId === undefined ? '' : 'WHERE work_item_id = $1'}
        ORDER BY observed_at ASC, id ASC;`,
      params,
    );

    const observations: RepairObservation[] = rows.map((row) => ({
      workItemId: row.work_item_id,
      attempt: row.attempt,
      monitorLegitimate: row.monitor_legitimate,
      heldOutPassed: row.held_out_passed,
      observedAt: new Date(String(row.observed_at)).toISOString(),
    }));

    return {
      ...scoreRepairMonitor(observations),
      ...(options.workItemId === undefined ? {} : { workItemId: options.workItemId }),
    };
  } finally {
    await db.close();
  }
}

export function formatMonitorReport(report: MonitorReport): string {
  const head = report.workItemId === undefined ? '' : `${report.workItemId}\n`;
  return `${head}${formatRepairScore(report)}`;
}

export function formatGrade(result: GradeResult): string {
  return [
    `${result.workItemId} attempt ${String(result.attempt)}: ${result.cell}`,
    `  monitor: ${result.monitorLegitimate ? 'legitimate' : 'refused'}`,
    `  held-out suite: ${result.heldOutPassed ? 'passed' : 'failed'}`,
    ...result.reasons.map((reason) => `    ${reason}`),
    ...(result.recorded ? [] : ['  already graded — the first grade stands']),
  ].join('\n');
}

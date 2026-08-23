/**
 * `sdlc metrics` (P3-MET-01, P3-MET-02).
 *
 * Flow metrics come out of `lifecycle_transitions`, which is a value stream map
 * by construction — a timestamped path per card — so nothing here needs
 * instrumentation that does not already exist.
 *
 * DORA is reported from whatever deployment history the daemon has, and reports
 * *nothing* rather than zero where that history is missing. A change-fail rate
 * of 0% because nothing was recorded and one because nothing failed render
 * identically, and one of them is excellent news.
 */

import {
  bottleneck,
  cycleTime,
  DEFAULT_WAIT_STAGES,
  doraReport,
  flowEfficiency,
  formatDora,
  leadTime,
  runMetrics,
  type RunMetrics,
  type RunRow,
  rework,
  stageStats,
  visitsByCard,
  type DeploymentEvent,
  type StageStat,
  type TransitionRow,
} from '@sdlc-on-fire/core';
import { openWorkspaceDatabase } from './commands.js';

export interface FlowReport {
  readonly cards: number;
  readonly stages: readonly StageStat[];
  readonly bottleneck: StageStat | null;
  readonly flowEfficiency: { activeMs: number; waitMs: number; ratio: number | null };
  readonly rework: ReturnType<typeof rework>;
  readonly perCard: readonly {
    readonly id: string;
    readonly leadTimeMs: number | null;
    readonly cycleTimeMs: number | null;
  }[];
}

export async function flowReport(root: string): Promise<FlowReport> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    const transitions = await db.query<TransitionRow>(
      `SELECT work_item_id, from_state, to_state, created_at::text AS created_at
         FROM lifecycle_transitions ORDER BY created_at ASC;`,
    );
    const created = await db.query<{ id: string; created_at: string }>(
      `SELECT id, created_at::text AS created_at FROM work_items;`,
    );
    const createdAt = new Map(created.map((row) => [row.id, row.created_at]));

    const byCard = visitsByCard(transitions);
    const all = [...byCard.values()].flat();

    return {
      cards: byCard.size,
      stages: stageStats(all),
      bottleneck: bottleneck(all),
      flowEfficiency: flowEfficiency(all, DEFAULT_WAIT_STAGES),
      rework: rework(byCard),
      perCard: [...byCard.entries()].map(([id, visits]) => ({
        id,
        leadTimeMs: leadTime(visits, createdAt.get(id) ?? ''),
        cycleTimeMs: cycleTime(visits),
      })),
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

const hours = (ms: number | null): string =>
  ms === null ? 'not available' : `${(ms / 3_600_000).toFixed(1)}h`;

export function formatFlow(report: FlowReport): string {
  if (report.cards === 0) {
    // Distinguished from "flow efficiency is 0%". No history and terrible flow
    // are different problems and the first is not a problem at all.
    return 'No lifecycle transitions recorded yet — nothing has moved, so there is no flow to measure.';
  }

  const lines = [
    `Flow across ${String(report.cards)} card(s)`,
    '',
    'Time per stage (the value stream):',
    ...report.stages.map(
      (stage) =>
        `  ${stage.stage.padEnd(18)} ${hours(stage.totalMs).padStart(10)}  ` +
        `${String(stage.visits)} visit(s), mean ${hours(stage.meanMs)}`,
    ),
  ];

  if (report.bottleneck !== null) {
    lines.push(
      '',
      `Binding constraint: ${report.bottleneck.stage} — ${hours(report.bottleneck.totalMs)} total.`,
      'Optimising anywhere else will not move throughput.',
    );
  }

  const efficiency = report.flowEfficiency;
  lines.push(
    '',
    efficiency.ratio === null
      ? 'Flow efficiency: not available — nothing measurable yet.'
      : `Flow efficiency: ${(efficiency.ratio * 100).toFixed(1)}% ` +
          `(${hours(efficiency.activeMs)} working, ${hours(efficiency.waitMs)} waiting)`,
  );

  if (report.rework.cardsWithRework > 0) {
    lines.push(
      '',
      `Rework: ${String(report.rework.cardsWithRework)} card(s) re-entered a stage ` +
        `(${String(report.rework.totalRevisits)} times). Worst: ` +
        report.rework.hotspots
          .slice(0, 3)
          .map((hotspot) => `${hotspot.stage} ×${String(hotspot.revisits)}`)
          .join(', '),
      'Rework is invisible in cycle time — a card that ping-pongs and one that walks',
      'straight through can take the same nine days.',
    );
  }

  return lines.join('\n');
}

/**
 * DORA, from recorded deployments.
 *
 * v0.1 has no deploy pipeline of its own, so this reads whatever `runs` rows
 * carry a PR URL — the closest thing to a shipped change the product currently
 * observes. Every metric it cannot compute is reported as unavailable with a
 * reason rather than as a number.
 */
export async function doraFromWorkspace(
  root: string,
  windowDays = 30,
): Promise<ReturnType<typeof doraReport>> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    const rows = await db.query<{
      finished_at: string | null;
      started_at: string | null;
      status: string;
    }>(
      `SELECT started_at::text AS started_at, finished_at::text AS finished_at, status
         FROM runs
        WHERE pr_url IS NOT NULL
          AND finished_at IS NOT NULL
          AND finished_at > now() - ($1 || ' days')::interval;`,
      [String(windowDays)],
    );

    const deployments: DeploymentEvent[] = rows
      .filter((row) => row.finished_at !== null)
      .map((row) => ({
        deployedAt: row.finished_at as string,
        authoredAt: row.started_at,
        failed: row.status === 'fail' || row.status === 'error',
      }));

    return doraReport(deployments, windowDays);
  } finally {
    await db.close().catch(() => undefined);
  }
}

export { formatDora };

/**
 * `sdlc metrics agents` (P6-INSTRUMENT-02; FEAT-MET-003/008/010).
 *
 * Reads the run rows P6-WRITEPATH-01 started writing. Before that this report
 * could only ever have said zero, which is why it was not built earlier: a
 * dashboard over an empty table is the failure mode this phase exists to close,
 * not a head start on it.
 */
export async function agentRunReport(root: string): Promise<RunMetrics> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    const rows = await db.query<{
      id: string;
      work_item_id: string;
      skill_id: string | null;
      status: string | null;
      failure_reason: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_usd: string | number | null;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, work_item_id, skill_id, status, failure_reason,
              input_tokens, output_tokens, cost_usd,
              started_at::text AS started_at, finished_at::text AS finished_at
         FROM runs ORDER BY started_at ASC;`,
    );

    return runMetrics(
      rows.map((row): RunRow => ({
        id: row.id,
        workItemId: row.work_item_id,
        skillId: row.skill_id,
        status: row.status,
        failureReason: row.failure_reason,
        inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
        outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
        // NUMERIC comes back as a string from both drivers. `Number(null)` is
        // 0, which would turn "no cost recorded" into "cost was zero" — the
        // one confusion the nullable column exists to prevent.
        costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      })),
    );
  } finally {
    await db.close().catch(() => undefined);
  }
}

export function formatAgentRuns(report: RunMetrics): string {
  if (report.runs === 0) {
    // Deliberately does not name a command. The first version said "dispatched
    // through `sdlc advance`" and that was false: `advance` moves a stage, it
    // does not dispatch. Naming a command that would not have produced a row
    // sends a reader to check the one thing that was never going to help.
    return 'no agent runs recorded yet — nothing has dispatched a skill in this workspace.';
  }

  const lines = [`${String(report.runs)} agent run(s)`, ''];

  lines.push('by work item:');
  for (const count of report.byWorkItem.slice(0, 10)) {
    lines.push(
      `  ${count.key}: ${String(count.runs)} run(s) — ${String(count.passed)} passed, ${String(count.failed)} failed, ${String(count.errored)} errored`,
    );
  }

  if (report.outliers.length > 0) {
    lines.push('', 'unusually many runs (at least double the median):');
    // The whole point of counting runs. A card at eleven attempts is a proxy for
    // a spec nobody could work from, and it is invisible in a sorted list.
    for (const outlier of report.outliers) {
      lines.push(`  ${outlier.key}: ${String(outlier.runs)} run(s)`);
    }
  }

  lines.push('', 'by skill:');
  for (const count of report.bySkill.slice(0, 10)) {
    lines.push(`  ${count.key}: ${String(count.runs)} run(s)`);
  }

  lines.push('', 'cost:');
  if (report.cost.totalUsd === null) {
    // Not "$0.00". A transport that reports nothing and one that spent nothing
    // render identically, and one of them is excellent news.
    lines.push('  not available — no run reported usage');
  } else {
    lines.push(
      `  $${report.cost.totalUsd.toFixed(4)} over ${String(report.cost.runsWithUsage)} of ${String(report.cost.runs)} run(s)`,
    );
    if (report.cost.runsWithUsage < report.cost.runs) {
      lines.push('  (partial — the rest reported no usage, so the total is a floor)');
    }
    if (report.cost.inputTokens !== null || report.cost.outputTokens !== null) {
      lines.push(
        `  tokens: ${String(report.cost.inputTokens ?? 0)} in, ${String(report.cost.outputTokens ?? 0)} out`,
      );
    }
  }

  const failures = report.failureReasons.filter((entry) => entry.runs > 0);
  lines.push('', 'failure reasons:');
  if (failures.length === 0) {
    lines.push('  none — every recorded run passed');
  } else {
    for (const entry of failures) lines.push(`  ${entry.reason}: ${String(entry.runs)}`);
  }

  return lines.join('\n');
}

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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import {
  adoptionBar,
  type AdoptionBar,
  type BlockOutcome,
  bottleneck,
  cycleTime,
  DEFAULT_WAIT_STAGES,
  doraReport,
  flowEfficiency,
  formatDora,
  formatHeldOutTrend,
  heldOutTrend,
  leadTime,
  blockedTime,
  gatePassRates,
  humanInterventions,
  insertionFrequency,
  PR_DURATION_UNAVAILABLE,
  runMetrics,
  type ApprovalRow,
  type BlockedTime,
  type GateEvaluation,
  type GateInterval,
  type GovernanceMetrics,
  type HeldOutSample,
  type HeldOutTrend,
  type InsertionRow,
  resolveWorkspaceLayout,
  type RunMetrics,
  type RunRow,
  rework,
  stageStats,
  visitsByCard,
  type DeploymentEvent,
  type StageStat,
  type TransitionRow,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
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
      cache_read_tokens: number | null;
      cache_creation_tokens: number | null;
      turns: number | null;
      started_at: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, work_item_id, skill_id, status, failure_reason,
              input_tokens, output_tokens, cost_usd,
              cache_read_tokens, cache_creation_tokens, turns,
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
        cacheReadTokens: row.cache_read_tokens === null ? null : Number(row.cache_read_tokens),
        cacheCreationTokens:
          row.cache_creation_tokens === null ? null : Number(row.cache_creation_tokens),
        turns: row.turns === null ? null : Number(row.turns),
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
  lines.push('', 'prompt cache:');
  if (report.cache.hitRate === null) {
    // Not "0%". No run reporting cache accounting and every run missing the
    // cache are different facts, and only one of them is a problem to fix.
    lines.push('  not available — no run reported cache accounting');
  } else {
    lines.push(
      `  ${(report.cache.hitRate * 100).toFixed(1)}% of intake read from cache, over ${String(report.cache.runsReporting)} run(s)`,
    );
  }

  lines.push('', 'trajectory:');
  if (report.trajectory.turnsPerRun === null) {
    lines.push('  not available — no run reported turns');
  } else {
    lines.push(
      `  ${report.trajectory.turnsPerRun.toFixed(1)} turns per run, over ${String(report.trajectory.runsReporting)} run(s)`,
    );
  }
  // Stated, not omitted. A trajectory section that silently lacks tool counts
  // reads as "there were none" (FEAT-MET-013).
  lines.push('  tool calls: not measured — needs `--output-format stream-json`');

  lines.push('', 'failure reasons:');
  if (failures.length === 0) {
    lines.push('  none — every recorded run passed');
  } else {
    for (const entry of failures) lines.push(`  ${entry.reason}: ${String(entry.runs)}`);
  }

  return lines.join('\n');
}

/**
 * `sdlc metrics blocked` (P6-INSTRUMENT-03, FEAT-MET-002).
 *
 * Reads gate intervals rather than lifecycle transitions, because `blocked` is
 * not a lifecycle state — it is an overlay derived from gate status, so the
 * transition log has nothing to say about it.
 */
export async function blockedReport(root: string): Promise<readonly BlockedTime[]> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    const rows = await db.query<{
      work_item_id: string;
      gate_name: string;
      created_at: string;
      resolved_at: string | null;
    }>(
      // A gate is "resolved" when it passed. A failing gate is still blocking,
      // which is the whole reason it exists — counting `fail` as resolved would
      // report the most blocked cards as the least.
      `SELECT work_item_id, gate_name, created_at::text AS created_at,
              CASE WHEN result = 'pass' THEN evaluated_at::text ELSE NULL END AS resolved_at
         FROM gates ORDER BY created_at ASC;`,
    );
    return blockedTime(
      rows.map((row): GateInterval => ({
        workItemId: row.work_item_id,
        gateName: row.gate_name,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
      })),
      new Date().toISOString(),
    );
  } finally {
    await db.close().catch(() => undefined);
  }
}

export function formatBlocked(report: readonly BlockedTime[]): string {
  if (report.length === 0) return 'no gates recorded — nothing has been blocked.';
  return [
    `${String(report.length)} work item(s) with gate history`,
    '',
    ...report.map(
      (item) =>
        `  ${item.workItemId}: ${hours(item.blockedMs)} across ${String(item.episodes)} episode(s)` +
        (item.stillBlocked ? ' — still blocked, this is a floor' : ''),
    ),
  ].join('\n');
}

/**
 * `sdlc metrics governance` (P6-INSTRUMENT-04; FEAT-MET-015/014/004/009).
 *
 * Insertions are read from `kanban/_insertions/`, not from `audit_log`.
 * FEAT-MET-014 says audit_log and nothing has ever written an insertion row
 * there — the record that exists is the markdown one, which is also the right
 * source under the content-in-git invariant. Flagged as a feature-text
 * divergence rather than papered over by adding a redundant audit write.
 */
export async function governanceReport(root: string): Promise<GovernanceMetrics> {
  const layout = resolveWorkspaceLayout(root);
  const insertions = await readInsertions(path.join(layout.kanbanDir, '_insertions'));

  const { db } = await openWorkspaceDatabase(root);
  try {
    const gateRows = await db.query<{
      work_item_id: string;
      gate_name: string;
      result: string | null;
      policy_id: number | null;
      required_role: string | null;
    }>(
      `SELECT g.work_item_id, g.gate_name, g.result, g.policy_id, r.key AS required_role
         FROM gates g
         LEFT JOIN gate_policies p ON p.id = g.policy_id
         LEFT JOIN roles r ON r.id = p.required_role_id;`,
    );

    const approvalRows = await db.query<{
      actor_kind: string;
      decision: string;
      revoked_at: string | null;
      created_at: string;
    }>(
      `SELECT a.kind AS actor_kind, ap.decision,
              ap.revoked_at::text AS revoked_at, ap.created_at::text AS created_at
         FROM approvals ap
         JOIN actors a ON a.id = ap.actor_id;`,
    );

    return {
      gates: gatePassRates(
        gateRows.map((row): GateEvaluation => ({
          workItemId: row.work_item_id,
          gateName: row.gate_name,
          result: row.result,
          requiredRole: row.required_role,
          policyId: row.policy_id,
        })),
      ),
      interventions: humanInterventions(
        approvalRows.map((row): ApprovalRow => ({
          actorKind: row.actor_kind,
          decision: row.decision,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
        })),
      ),
      insertions: insertionFrequency(insertions),
      prDuration: PR_DURATION_UNAVAILABLE,
    };
  } finally {
    await db.close().catch(() => undefined);
  }
}

/** Insertion records as written by `sdlc add` — content in git, read as such. */
async function readInsertions(dir: string): Promise<readonly InsertionRow[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const rows: InsertionRow[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    const data = parseFrontmatter(raw).data;
    const id = data['id'];
    const into = data['into'];
    const state = data['state'];
    const recordedAt = data['recorded_at'];
    // A record missing any of these is malformed rather than a zero; skipping it
    // keeps a hand-edited file from becoming an insertion that happened at the
    // epoch and inflating every rate below it.
    if (
      typeof id !== 'string' ||
      typeof into !== 'string' ||
      typeof state !== 'string' ||
      typeof recordedAt !== 'string'
    ) {
      continue;
    }
    rows.push({ id, into, state, recordedAt });
  }
  return rows;
}

export function formatGovernance(report: GovernanceMetrics): string {
  const lines: string[] = ['gate pass rate by policy/role:'];
  if (report.gates.length === 0) {
    lines.push('  no gates recorded');
  } else {
    for (const rate of report.gates) {
      lines.push(
        `  ${rate.key} (${rate.gateName}): ` +
          (rate.passRate === null
            ? `not available — ${String(rate.pending)} pending, nothing decided`
            : `${(rate.passRate * 100).toFixed(0)}% of ${String(rate.passed + rate.failed)} decided` +
              (rate.pending > 0 ? `, ${String(rate.pending)} pending` : '')),
      );
    }
  }

  lines.push(
    '',
    'human interventions:',
    `  ${String(report.interventions.approvals)} approval(s), ${String(report.interventions.rejections)} rejection(s), ${String(report.interventions.revocations)} revoked`,
  );
  if (report.interventions.agentApprovals > 0) {
    // Loud, because it should be impossible: the schema refuses an agent
    // approval outright. This is a broken invariant, not a statistic.
    lines.push(
      `  ⚠ ${String(report.interventions.agentApprovals)} AGENT approval(s) recorded — the schema forbids these (ADR-0010)`,
    );
  }

  lines.push('', 'insertions:');
  lines.push(
    `  ${String(report.insertions.total)} recorded — ${String(report.insertions.approved)} approved, ${String(report.insertions.rejected)} rejected, ${String(report.insertions.proposed)} held`,
  );
  lines.push(
    report.insertions.perThirtyDays === null
      ? '  rate: not available — a rate needs at least two records to have a span'
      : `  rate: ${report.insertions.perThirtyDays.toFixed(1)} per 30 days`,
  );
  for (const container of report.insertions.byContainer.slice(0, 5)) {
    lines.push(`  ${container.into}: ${String(container.insertions)} insertion(s)`);
  }

  lines.push('', `PR duration: not available — ${report.prDuration.because}`);
  return lines.join('\n');
}

/**
 * `sdlc metrics held-out` — the visible-vs-held-out gap, and where it is going
 * (P7-HELDOUT-02, `techniques/42`).
 *
 * The one honest measure of a repair loop, and until now it existed only
 * per-item inside `sdlc criteria status`, computed fresh and thrown away. A
 * number you cannot compare to last week's is a number nobody acts on: 12pp is
 * fine on a big change and alarming on a small one, and only the *direction*
 * separates the two readings.
 *
 * Items with no held-out criteria are counted and named rather than skipped
 * silently. On most workspaces that will be nearly all of them, and a report
 * that quietly omitted them would show a confident gap over the three items
 * somebody happened to measure.
 */
export interface HeldOutItemTrend {
  readonly workItemId: string;
  readonly trend: HeldOutTrend;
  readonly latestDeltaPp: number | null;
}

export interface HeldOutReport {
  readonly items: readonly HeldOutItemTrend[];
  /** Items with a measured delta, and items with none — both stated. */
  readonly measuredItems: number;
  readonly unmeasuredItems: number;
  /** Items whose gap is widening. The only number worth an alert. */
  readonly widening: readonly string[];
  readonly overall: HeldOutTrend;
}

interface SampleRow {
  readonly work_item_id: string;
  readonly measured_at: string;
  readonly visible_passed: number;
  readonly visible_total: number;
  readonly held_out_passed: number;
  readonly held_out_total: number;
  readonly delta_pp: string | null;
  readonly changed_lines: number | null;
}

export async function heldOutReport(root: string): Promise<HeldOutReport> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<SampleRow>(
      `SELECT work_item_id, measured_at, visible_passed, visible_total,
              held_out_passed, held_out_total, delta_pp, changed_lines
         FROM held_out_samples ORDER BY measured_at ASC, id ASC;`,
    );

    const samples: HeldOutSample[] = rows.map((row) => ({
      workItemId: row.work_item_id,
      measuredAt: new Date(String(row.measured_at)).toISOString(),
      visiblePassed: row.visible_passed,
      visibleTotal: row.visible_total,
      heldOutPassed: row.held_out_passed,
      heldOutTotal: row.held_out_total,
      // `numeric` reads back as a string, and `Number(null)` is 0 — the one
      // value this column must never invent.
      deltaPp: row.delta_pp === null ? null : Number(row.delta_pp),
      ...(row.changed_lines === null ? {} : { changedLines: row.changed_lines }),
    }));

    const byItem = new Map<string, HeldOutSample[]>();
    for (const sample of samples) {
      const bucket = byItem.get(sample.workItemId) ?? [];
      bucket.push(sample);
      byItem.set(sample.workItemId, bucket);
    }

    const items = [...byItem.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([workItemId, itemSamples]) => {
        const trend = heldOutTrend(itemSamples);
        return { workItemId, trend, latestDeltaPp: trend.latest?.deltaPp ?? null };
      });

    return {
      items,
      measuredItems: items.filter((item) => item.latestDeltaPp !== null).length,
      unmeasuredItems: items.filter((item) => item.latestDeltaPp === null).length,
      widening: items
        .filter((item) => item.trend.direction === 'widening')
        .map((item) => item.workItemId),
      // The workspace-wide view is the same arithmetic over every sample. It
      // answers a coarser question than the per-item trends and is reported
      // beside them rather than instead of them.
      overall: heldOutTrend(samples),
    };
  } finally {
    await db.close();
  }
}

export function formatHeldOut(report: HeldOutReport): string {
  if (report.items.length === 0) {
    return [
      'no held-out samples recorded yet',
      '',
      'Record one with `sdlc criteria status <id> --record` once an item has',
      'held-out criteria. Until then the gap is unknown, which is not the same',
      'as small.',
    ].join('\n');
  }

  const lines = [
    `${String(report.items.length)} item(s) sampled — ${String(report.measuredItems)} measured, ${String(report.unmeasuredItems)} with no held-out criteria`,
    '',
    formatHeldOutTrend(report.overall),
    '',
  ];

  for (const item of report.items) {
    const mark = item.trend.direction === 'widening' ? '⚠' : ' ';
    lines.push(
      `${mark} ${item.workItemId}: ${item.latestDeltaPp === null ? 'unmeasured' : `Δ ${String(item.latestDeltaPp)}pp`} · ${item.trend.direction}`,
    );
  }

  if (report.widening.length > 0) {
    lines.push(
      '',
      `${String(report.widening.length)} item(s) widening: ${report.widening.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * `sdlc metrics adoption` (P8-BAR-02, ADR-0063, metrics.md §3a).
 *
 * The five signals of the adoption bar, read from `gates`, `gate_outcome_tags`,
 * `config_events` and `approvals`. Nothing here infers anything — every number
 * is a count of rows somebody's action created.
 *
 * The blocks query is **unscoped on purpose**. Every other report in this file
 * takes a window; this one must not, because `adoptionBar` computes rates over
 * judged blocks and a windowed block set would silently drop tags that fall
 * outside it. (`orphanTags` exists to catch exactly that if a window is ever
 * added, rather than to permit one.)
 */
export async function adoptionBarReport(root: string): Promise<AdoptionBar> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    const blocks = await db.query<{
      id: number;
      work_item_id: string;
      gate_name: string;
      created_at: string;
    }>(
      `SELECT id, work_item_id, gate_name, created_at::text AS created_at
         FROM gates WHERE result = 'fail' ORDER BY created_at ASC;`,
    );

    const tags = await db.query<{
      gate_id: number;
      actor_id: string;
      outcome: string;
      reason: string | null;
      tagged_at: string;
    }>(
      `SELECT gate_id, actor_id, outcome, reason, tagged_at::text AS tagged_at
         FROM gate_outcome_tags ORDER BY id ASC;`,
    );

    const events = await db.query<{ observed_at: string; direction: string }>(
      // The baseline row carries an empty change list and is not a change.
      // Counting it would make every workspace report one config event on the
      // day it was created.
      `SELECT observed_at::text AS observed_at, direction FROM config_events
        WHERE jsonb_array_length(changes) > 0 ORDER BY id ASC;`,
    );

    const overrides = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM approvals WHERE decision = 'override';`,
    );

    return adoptionBar({
      blocks: blocks.map((row) => ({
        gateId: Number(row.id),
        workItemId: row.work_item_id,
        gateName: row.gate_name,
        blockedAt: new Date(row.created_at).toISOString(),
      })),
      tags: tags.map((row) => ({
        gateId: Number(row.gate_id),
        actorId: row.actor_id,
        outcome: row.outcome as BlockOutcome,
        reason: row.reason,
        taggedAt: new Date(row.tagged_at).toISOString(),
      })),
      configEvents: events.map((row) => ({
        observedAt: new Date(row.observed_at).toISOString(),
        direction: row.direction,
      })),
      overrides: Number(overrides[0]?.n ?? 0),
    });
  } finally {
    await db.close().catch(() => undefined);
  }
}

function signal(label: string, value: AdoptionBar['valuableRate'], unit: 'rate' | 'count'): string {
  if (value.value === null) return `  ${label.padEnd(26)} not available — ${value.because}`;
  const shown =
    unit === 'rate'
      ? `${(value.value * 100).toFixed(0)}%  (${String(value.numerator)}/${String(value.denominator)})`
      : `${String(value.value)} block(s) of ${String(value.denominator)}`;
  return `  ${label.padEnd(26)} ${shown}`;
}

export function formatAdoptionBar(report: AdoptionBar): string {
  const lines = [
    'The adoption bar (ADR-0063) — the gate caught something real the user was',
    'glad about, and never got in the way when it should not have.',
    '',
    signal('valuable-block rate', report.valuableRate, 'rate'),
    signal('nuisance-block rate', report.nuisanceRate, 'rate'),
    signal('blocks to first valuable', report.blocksToFirstValuable, 'count'),
    signal('config-downgrade rate', report.downgradeRate, 'rate'),
    signal('override rate', report.overrideRate, 'rate'),
    '',
  ];
  if (report.untagged > 0) {
    lines.push(
      `  ${String(report.untagged)} block(s) nobody judged — the rates above are over the rest.`,
    );
  }
  if (report.orphanTags.length > 0) {
    lines.push(
      `  ⚠ ${String(report.orphanTags.length)} tag(s) reference a gate not in this report: ${report.orphanTags.join(', ')}`,
    );
  }
  lines.push(
    '',
    report.met === null
      ? 'UNMEASURED — ' + report.because
      : (report.met ? 'MET — ' : 'NOT MET — ') + report.because,
  );
  return lines.join('\n');
}

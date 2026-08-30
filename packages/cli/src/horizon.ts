import {
  accountRun,
  assessDegradation,
  formatDegradation,
  formatCompactionPlan,
  formatRunAccount,
  planCompaction,
  windowBlindnessRatio,
  WorkspaceConfigSchema,
  type CompactionPlan,
  type DegradationVerdict,
  type RunContextAccount,
  type TurnAccounting,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase, readConfig } from './commands.js';

/**
 * `sdlc metrics horizon` — how much context a run actually took in
 * (P7-HORIZON-01).
 *
 * Every context metric this product had measured **one window**. That is the
 * one shape of measurement guaranteed to look healthy on the runs worth
 * worrying about, because each individual window of a forty-turn run is fine.
 */

export interface TurnInput {
  readonly runId: string;
  readonly turn: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly observedAt?: string | undefined;
}

export interface RecordTurnResult {
  readonly runId: string;
  readonly turn: number;
  /** False when this turn was already accounted for. */
  readonly recorded: boolean;
}

/**
 * Records one turn's accounting.
 *
 * `DO NOTHING` on conflict: a turn number is a position in a sequence, and a
 * retry that overwrote turn 7 would change the shape of a run that already
 * happened — which is the only thing these rows exist to describe.
 */
export async function recordTurn(root: string, input: TurnInput): Promise<RecordTurnResult> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{ id: number }>(
      `INSERT INTO run_turns
         (run_id, turn, observed_at, input_tokens, output_tokens, cache_read_tokens)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6)
       ON CONFLICT (run_id, turn) DO NOTHING
       RETURNING id;`,
      [
        input.runId,
        input.turn,
        input.observedAt ?? null,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens ?? null,
      ],
    );
    return { runId: input.runId, turn: input.turn, recorded: rows.length > 0 };
  } finally {
    await db.close();
  }
}

export interface HorizonReport {
  readonly accounts: readonly RunContextAccount[];
  /** Runs whose accumulated context most exceeded their largest window. */
  readonly worstBlindnessRatio: number | null;
  readonly runId?: string | undefined;
}

async function turnsFor(
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
  runId: string | undefined,
): Promise<TurnAccounting[]> {
  const rows = await db.query<{
    run_id: string;
    turn: number;
    observed_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number | null;
  }>(
    `SELECT run_id, turn, observed_at, input_tokens, output_tokens, cache_read_tokens
       FROM run_turns
      ${runId === undefined ? '' : 'WHERE run_id = $1'}
      ORDER BY run_id ASC, turn ASC;`,
    runId === undefined ? [] : [runId],
  );

  return rows.map((row) => ({
    runId: row.run_id,
    turn: row.turn,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    // NULL means the provider reported nothing, which is a different fact from
    // "nothing was cached" — but for accumulation both add zero, so the
    // distinction is carried rather than collapsed.
    ...(row.cache_read_tokens === null ? {} : { cacheReadTokens: row.cache_read_tokens }),
    at: new Date(String(row.observed_at)).toISOString(),
  }));
}

export async function horizonReport(
  root: string,
  options: { readonly runId?: string | undefined } = {},
): Promise<HorizonReport> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const turns = await turnsFor(db, options.runId);

    const byRun = new Map<string, TurnAccounting[]>();
    for (const turn of turns) {
      const bucket = byRun.get(turn.runId) ?? [];
      bucket.push(turn);
      byRun.set(turn.runId, bucket);
    }

    const accounts = [...byRun.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([runId, runTurns]) => accountRun(runId, runTurns));

    const ratios = accounts
      .map((account) => windowBlindnessRatio(account))
      .filter((ratio): ratio is number => ratio !== null);

    return {
      accounts,
      worstBlindnessRatio: ratios.length === 0 ? null : Math.max(...ratios),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
    };
  } finally {
    await db.close();
  }
}

export function formatHorizon(report: HorizonReport): string {
  if (report.accounts.length === 0) {
    return [
      'no per-turn accounting recorded yet',
      '',
      'Without it the only context numbers available are per-window, and a long',
      'run is precisely the case where every window looks fine.',
    ].join('\n');
  }

  const lines = report.accounts.map((account) => formatRunAccount(account));
  if (report.worstBlindnessRatio !== null && report.worstBlindnessRatio > 1) {
    lines.push(
      '',
      `worst window blindness: ${String(report.worstBlindnessRatio)}× — the run whose per-window metrics described the smallest share of what happened`,
    );
  }
  return lines.join('\n\n');
}

/**
 * The declared per-run context budget, from workspace config.
 *
 * Zero means undeclared, and undeclared means compaction never fires. A default
 * ceiling picked by us would be a number nobody chose, silently discarding
 * context on somebody else's project.
 */
async function contextConfig(root: string): Promise<{
  budget: number;
  compactAt: number;
  retainRecent: number;
}> {
  // `readConfig` rather than a second reader: it already distinguishes an
  // absent config (null) from a broken one (a SetupError naming the file, the
  // parser's complaint and the fix), and a second copy of that handling would
  // drift into a compaction that silently stopped firing on a workspace that
  // had asked for it.
  //
  // `openWorkspaceDatabase` below validates the same file through the same
  // function, so a broken config is refused whichever of the two runs first —
  // which is why swallowing the error here is an *equivalent* mutation rather
  // than a hole. Stated because a reader checking whether this throw is load
  // bearing deserves the answer without tracing the second call.
  const config = (await readConfig(root)) ?? WorkspaceConfigSchema.parse({});
  return {
    budget: config.context.run_budget_tokens,
    compactAt: config.context.compact_at,
    retainRecent: config.context.retain_recent_turns,
  };
}

export interface CompactResult {
  readonly plan: CompactionPlan;
  /** Whether the plan was written down. False for a dry run or a no-op. */
  readonly recorded: boolean;
}

/**
 * `sdlc compact <run>` — fire compaction against the declared budget
 * (P7-HORIZON-02).
 *
 * Planning is pure and lives in core; this reads the turns, applies the plan,
 * and writes the record. The record is the point: a trim that leaves no trace
 * is forgetting.
 */
export async function compactRun(
  root: string,
  runId: string,
  options: {
    readonly apply?: boolean | undefined;
    readonly budgetTokens?: number | undefined;
    readonly firedAt?: string | undefined;
  } = {},
): Promise<CompactResult> {
  const config = await contextConfig(root);
  const budget = options.budgetTokens ?? config.budget;

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const turns = await turnsFor(db, runId);
    const account = accountRun(runId, turns);
    const plan = planCompaction(account, turns, budget, {
      compactAt: config.compactAt,
      retainRecent: config.retainRecent,
    });

    if (!plan.fired || options.apply !== true) return { plan, recorded: false };

    await db.query(
      `INSERT INTO run_compactions
         (run_id, fired_at, budget_tokens, accumulated_before, freed_tokens,
          dropped_turns, retained_turns, reason)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6::jsonb, $7::jsonb, $8);`,
      [
        runId,
        options.firedAt ?? null,
        plan.budgetTokens,
        plan.accumulatedBefore,
        plan.freedTokens,
        JSON.stringify(plan.droppedTurns),
        JSON.stringify(plan.retainedTurns),
        plan.reason,
      ],
    );
    return { plan, recorded: true };
  } finally {
    await db.close();
  }
}

export interface CompactionRecord {
  readonly runId: string;
  readonly firedAt: string;
  readonly budgetTokens: number;
  readonly accumulatedBefore: number;
  readonly freedTokens: number;
  readonly droppedTurns: readonly number[];
  readonly retainedTurns: readonly number[];
  readonly reason: string;
}

/** Every compaction on a run — what an unexplainable output is checked against. */
export async function compactionsFor(
  root: string,
  runId: string,
): Promise<readonly CompactionRecord[]> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{
      run_id: string;
      fired_at: string;
      budget_tokens: number;
      accumulated_before: number;
      freed_tokens: number;
      dropped_turns: number[];
      retained_turns: number[];
      reason: string;
    }>(
      `SELECT run_id, fired_at, budget_tokens, accumulated_before, freed_tokens,
              dropped_turns, retained_turns, reason
         FROM run_compactions WHERE run_id = $1 ORDER BY fired_at ASC, id ASC;`,
      [runId],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      firedAt: new Date(String(row.fired_at)).toISOString(),
      budgetTokens: row.budget_tokens,
      accumulatedBefore: row.accumulated_before,
      freedTokens: row.freed_tokens,
      droppedTurns: row.dropped_turns,
      retainedTurns: row.retained_turns,
      reason: row.reason,
    }));
  } finally {
    await db.close();
  }
}

export function formatCompact(result: CompactResult): string {
  const text = formatCompactionPlan(result.plan);
  if (!result.plan.fired) return text;
  return result.recorded
    ? text
    : `${text}\n\n  dry run — nothing was recorded. Re-run with --apply.`;
}

export interface DegradationReport {
  readonly verdicts: readonly DegradationVerdict[];
  /** Runs with at least one tripwire fired. */
  readonly degraded: readonly string[];
  /** Runs with no accounting — unmeasured is a state, and it is not "healthy". */
  readonly unmeasured: readonly string[];
}

/**
 * `sdlc metrics degradation` — which runs have gone past the point their
 * context is useful (P7-HORIZON-03).
 *
 * Surfaced rather than left to be inferred from bad output, which is the worst
 * possible detector for it: a long run stays fluent as it degrades, and what
 * changes is that it stops being about the task.
 */
export async function degradationReport(
  root: string,
  options: { readonly runId?: string | undefined } = {},
): Promise<DegradationReport> {
  const config = await contextConfig(root);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const turns = await turnsFor(db, options.runId);

    const compactionCounts = new Map<string, number>();
    const counts = await db.query<{ run_id: string; count: number }>(
      `SELECT run_id, COUNT(*)::int AS count FROM run_compactions
        ${options.runId === undefined ? '' : 'WHERE run_id = $1'}
        GROUP BY run_id;`,
      options.runId === undefined ? [] : [options.runId],
    );
    for (const row of counts) compactionCounts.set(row.run_id, row.count);

    const byRun = new Map<string, typeof turns>();
    for (const turn of turns) {
      const bucket = byRun.get(turn.runId) ?? [];
      bucket.push(turn);
      byRun.set(turn.runId, bucket);
    }

    // Runs that were compacted but have no turn rows still get a verdict, and
    // it is `unmeasured`. Dropping them would hide the runs where accounting
    // itself failed — the ones most worth looking at.
    for (const runId of compactionCounts.keys()) {
      if (!byRun.has(runId)) byRun.set(runId, []);
    }

    const verdicts = [...byRun.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([runId, runTurns]) =>
        assessDegradation({
          account: accountRun(runId, runTurns),
          budgetTokens: config.budget,
          compactions: compactionCounts.get(runId) ?? 0,
        }),
      );

    return {
      verdicts,
      degraded: verdicts.filter((v) => v.degraded).map((v) => v.runId),
      unmeasured: verdicts.filter((v) => !v.measured).map((v) => v.runId),
    };
  } finally {
    await db.close();
  }
}

export function formatDegradationReport(report: DegradationReport): string {
  if (report.verdicts.length === 0) {
    return 'no runs with per-turn accounting — nothing to assess';
  }
  const lines = report.verdicts.map((verdict) => formatDegradation(verdict));
  if (report.degraded.length > 0) {
    lines.push('', `${String(report.degraded.length)} degraded: ${report.degraded.join(', ')}`);
  }
  return lines.join('\n\n');
}

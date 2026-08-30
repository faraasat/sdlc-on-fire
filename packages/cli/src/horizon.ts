import {
  accountRun,
  formatRunAccount,
  windowBlindnessRatio,
  type RunContextAccount,
  type TurnAccounting,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

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

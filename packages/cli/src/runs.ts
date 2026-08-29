import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc runs` — the run history (P6-SURFACE-07, FEAT-STORE-020).
 *
 * `sdlc metrics agents` aggregates the same rows, and aggregates are the wrong
 * shape for the question people actually arrive with, which is never "what is
 * the mean cost per run" but "what happened on this card, in order". A p95 does
 * not tell you that the third attempt broke its output contract and the fourth
 * one worked; the list does.
 *
 * Joined to the work item deliberately. A run id is a uuid nobody recognises,
 * and a history you cannot line up against the cards is a log rather than a
 * history.
 *
 * **Reads, never repairs.** A run row that says `running` two days after it
 * started is almost certainly a process that died, and it is reported exactly
 * as it is stored — a history surface that tidied the record on read would make
 * the interesting rows the ones you can no longer see.
 */

export interface RunRow {
  readonly id: string;
  readonly workItemId: string;
  readonly workItemTitle: string | null;
  readonly skillId: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly failureReason: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly contextPackPath: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
}

export interface RunHistory {
  readonly runs: readonly RunRow[];
  /** Rows matching the filter, before `limit` was applied. */
  readonly total: number;
  readonly limit: number;
  readonly workItemId?: string | undefined;
}

export const DEFAULT_RUN_LIMIT = 20;

interface RawRow {
  readonly id: string;
  readonly work_item_id: string;
  readonly title: string | null;
  readonly skill_id: string | null;
  readonly model: string | null;
  readonly status: string | null;
  readonly failure_reason: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cost_usd: string | null;
  readonly turns: number | null;
  readonly context_pack_path: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

/** `numeric` comes back as a string; a silent `Number()` on null would be 0. */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Duration, or null when the run has no end.
 *
 * The null check is the intended guard, not a redundant one — `Date.parse(null)`
 * happening to yield NaN is an accident of coercion, and a reader should not
 * have to know that to see why an unfinished run has no duration.
 */
function durationOf(row: RawRow): number | null {
  if (row.started_at === null || row.finished_at === null) return null;
  const ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
  return Number.isNaN(ms) ? null : ms;
}

export interface RunHistoryOptions {
  readonly workItemId?: string | undefined;
  readonly limit?: number | undefined;
  /** Only runs that ended this way. */
  readonly status?: string | undefined;
}

export async function runHistory(
  root: string,
  options: RunHistoryOptions = {},
): Promise<RunHistory> {
  const limit = options.limit ?? DEFAULT_RUN_LIMIT;
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.workItemId !== undefined) {
      params.push(options.workItemId);
      filters.push(`r.work_item_id = $${String(params.length)}`);
    }
    if (options.status !== undefined) {
      params.push(options.status);
      filters.push(`r.status = $${String(params.length)}`);
    }
    const where = filters.length === 0 ? '' : `WHERE ${filters.join(' AND ')}`;

    const counted = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM runs r ${where};`,
      params,
    );

    // Newest first, and `started_at NULLS LAST` rather than plain DESC: a run
    // recorded before it began has no start time, and Postgres sorts NULL as
    // largest on DESC, which would float every unstarted row to the top of a
    // list whose whole purpose is recency.
    const rows = await db.query<RawRow>(
      `SELECT r.id, r.work_item_id, w.title, r.skill_id, r.model, r.status, r.failure_reason,
              r.input_tokens, r.output_tokens, r.cost_usd, r.turns, r.context_pack_path,
              r.started_at, r.finished_at
         FROM runs r
         LEFT JOIN work_items w ON w.id = r.work_item_id
         ${where}
        ORDER BY r.started_at DESC NULLS LAST, r.id DESC
        LIMIT ${String(Math.max(1, Math.trunc(limit)))};`,
      params,
    );

    return {
      runs: rows.map((row) => ({
        id: row.id,
        workItemId: row.work_item_id,
        workItemTitle: row.title,
        skillId: row.skill_id,
        model: row.model,
        status: row.status,
        failureReason: row.failure_reason,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        costUsd: toNumber(row.cost_usd),
        turns: row.turns,
        contextPackPath: row.context_pack_path,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: durationOf(row),
      })),
      total: counted[0]?.count ?? 0,
      limit,
      ...(options.workItemId === undefined ? {} : { workItemId: options.workItemId }),
    };
  } finally {
    await db.close();
  }
}

const MARK: Readonly<Record<string, string>> = {
  pass: '✓',
  fail: '✗',
  error: '✗',
  running: '·',
  pending: '·',
};

export function formatRuns(history: RunHistory): string {
  if (history.runs.length === 0) {
    return history.workItemId === undefined
      ? 'no runs recorded yet'
      : `no runs recorded for ${history.workItemId}`;
  }

  const lines = history.runs.map((run) => {
    const head = [
      MARK[run.status ?? ''] ?? '?',
      run.workItemId,
      run.skillId ?? '(no skill)',
      run.status ?? 'unknown',
    ].join(' ');

    const detail = [
      run.model === null ? null : run.model,
      run.durationMs === null ? null : `${String(Math.round(run.durationMs / 1000))}s`,
      run.turns === null ? null : `${String(run.turns)} turn(s)`,
      // "not reported" rather than 0: a transport that says nothing about cost
      // is a different fact from one that says the run was free.
      run.costUsd === null ? 'cost not reported' : `$${run.costUsd.toFixed(4)}`,
      run.failureReason === null ? null : `reason: ${run.failureReason}`,
    ].filter((part): part is string => part !== null);

    return [
      `${head}\n  ${detail.join(' · ')}`,
      run.startedAt === null ? null : `  ${run.startedAt}`,
    ]
      .filter((part): part is string => part !== null)
      .join('\n');
  });

  if (history.total > history.runs.length) {
    lines.push(
      '',
      `showing ${String(history.runs.length)} of ${String(history.total)} — --limit for more`,
    );
  }
  return lines.join('\n');
}

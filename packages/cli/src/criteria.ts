import {
  admitHeldOut,
  formatHeldOutDelta,
  heldOutDelta,
  type HeldOutSample,
  summariseHeldOut,
  expectedGapPp,
  type CriterionResult,
  type HeldOutCriterion,
  type HeldOutDelta,
  type HeldOutSummary,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { whoami } from './access.js';

/**
 * `sdlc criteria` — the held-out half of a work item's acceptance (P3-GATE-09).
 *
 * The visible criteria live in the card's `done:` list, in git, where the agent
 * implementing against them reads them. These do not. The command is the only
 * way in and it deliberately has no way out: there is no subcommand that prints
 * the text, because a command that prints it is a command an agent can run.
 */

interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function withDb<T>(root: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** The card's visible `done:` list, read from the file in git. */
async function visibleCriteria(root: string, id: string): Promise<string[]> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);
  const data = parseFrontmatter(await fs.readFile(found.filePath, 'utf8')).data;
  const done = data['done'];
  return Array.isArray(done)
    ? done.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export interface AddCriterionResult {
  readonly workItemId: string;
  readonly count: number;
  readonly authorDisplayName: string;
}

/**
 * `sdlc criteria hold-out` — record a criterion the implementer will not see.
 *
 * The author is resolved from git config rather than passed as a flag. A flag
 * would make "a different actor" a claim, and the whole check is that it is not.
 */
export async function addHeldOut(
  root: string,
  id: string,
  text: string,
): Promise<AddCriterionResult> {
  const me = await whoami(root);
  const visible = await visibleCriteria(root, id);

  return withDb(root, async (db) => {
    const claim = await db.query<{ claimed_by: string | null }>(
      'SELECT claimed_by FROM work_items WHERE id = $1;',
      [id],
    );
    const implementer = claim[0]?.claimed_by ?? null;

    const admission = admitHeldOut({
      text,
      authorActorId: me.actor.id,
      implementerActorId: implementer,
      visibleCriteria: visible,
    });
    if (!admission.admitted) {
      throw new Error(`refused (${admission.refusal ?? 'unknown'}): ${admission.because ?? ''}`);
    }

    await db.query(
      'INSERT INTO held_out_criteria (work_item_id, text, author_actor_id) VALUES ($1,$2,$3);',
      [id, text.trim(), me.actor.id],
    );
    const rows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM held_out_criteria WHERE work_item_id = $1;',
      [id],
    );
    return {
      workItemId: id,
      count: rows[0]?.count ?? 0,
      authorDisplayName: me.actor.displayName,
    };
  });
}

export interface CriteriaStatus {
  readonly summary: HeldOutSummary;
  readonly delta: HeldOutDelta;
  readonly visible: readonly string[];
  /** The gap a change of this size predicts, for comparison against the real one. */
  readonly expectedGapPp: number;
  readonly changedLines: number;
  readonly ok: boolean;
  /** Whether this measurement was appended to the trend. */
  readonly recorded: boolean;
}

/**
 * `sdlc criteria status` — the count, the delta, and the gap this size predicts.
 *
 * Never the text. The summary shape has no field it could travel in, so this
 * cannot leak it by forgetting to filter.
 */
export async function criteriaStatus(
  root: string,
  id: string,
  results: {
    readonly visible?: readonly CriterionResult[];
    readonly heldOut?: readonly CriterionResult[];
    readonly changedLines?: number;
    /**
     * Persist this measurement for the trend (P7-HELDOUT-02).
     *
     * Off by default so `criteria status` stays a read. A status command that
     * silently wrote a sample every time somebody looked would make the trend a
     * record of how often the report was run.
     */
    readonly record?: boolean | undefined;
    readonly measuredAt?: string | undefined;
  } = {},
): Promise<CriteriaStatus> {
  const visible = await visibleCriteria(root, id);

  return withDb(root, async (db) => {
    const rows = await db.query<{
      id: string;
      text: string;
      author_actor_id: string;
      created_at: Date | string;
    }>(
      'SELECT id, text, author_actor_id, created_at FROM held_out_criteria WHERE work_item_id = $1 ORDER BY id;',
      [id],
    );
    const criteria: HeldOutCriterion[] = rows.map((row) => ({
      id: String(row.id),
      workItemId: id,
      text: row.text,
      authorActorId: row.author_actor_id,
      createdAt: new Date(String(row.created_at)).toISOString(),
    }));

    // Absent results are reported as unmeasured rather than assumed passing.
    const visibleResults =
      results.visible ?? visible.map((_, index) => ({ id: `v${String(index)}`, passed: false }));
    const heldOutResults =
      results.heldOut ?? criteria.map((entry) => ({ id: entry.id, passed: false }));

    const delta = heldOutDelta(
      results.visible === undefined ? [] : visibleResults,
      results.heldOut === undefined ? [] : heldOutResults,
    );
    const changedLines = results.changedLines ?? 0;

    const recorded = results.record === true;
    if (recorded) {
      await recordHeldOutSample(db, id, delta, changedLines, results.measuredAt);
    }

    return {
      summary: summariseHeldOut(id, criteria),
      delta,
      visible,
      expectedGapPp: expectedGapPp(changedLines),
      changedLines,
      // Unmeasured is not a failure — most items will not have held-out
      // criteria, and treating that as red would train people to ignore it.
      ok:
        delta.deltaPp === null ||
        delta.deltaPp <= 0 ||
        delta.deltaPp <= expectedGapPp(changedLines),
      recorded,
    };
  });
}

/** Appends one measurement. Never updates — see contract 01 §3.4. */
export async function recordHeldOutSample(
  db: { query(sql: string, params?: unknown[]): Promise<unknown> },
  workItemId: string,
  delta: HeldOutDelta,
  changedLines: number,
  measuredAt?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO held_out_samples
       (work_item_id, measured_at, visible_passed, visible_total,
        held_out_passed, held_out_total, delta_pp, changed_lines)
     VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8);`,
    [
      workItemId,
      measuredAt ?? null,
      delta.visiblePassed,
      delta.visibleTotal,
      delta.heldOutPassed,
      delta.heldOutTotal,
      // NULL, never 0. The column exists to keep "they agree" and "nothing was
      // measured" apart, and a coalesce here would erase exactly that.
      delta.deltaPp,
      changedLines,
    ],
  );
}

/** Every sample for one work item, oldest first. */
export async function heldOutSamples(root: string, id: string): Promise<readonly HeldOutSample[]> {
  return withDb(root, async (db) => {
    const rows = await db.query<{
      work_item_id: string;
      measured_at: string;
      visible_passed: number;
      visible_total: number;
      held_out_passed: number;
      held_out_total: number;
      delta_pp: string | null;
      changed_lines: number | null;
    }>(
      `SELECT work_item_id, measured_at, visible_passed, visible_total,
              held_out_passed, held_out_total, delta_pp, changed_lines
         FROM held_out_samples WHERE work_item_id = $1 ORDER BY measured_at ASC, id ASC;`,
      [id],
    );
    return rows.map((row) => ({
      workItemId: row.work_item_id,
      measuredAt: new Date(String(row.measured_at)).toISOString(),
      visiblePassed: row.visible_passed,
      visibleTotal: row.visible_total,
      heldOutPassed: row.held_out_passed,
      heldOutTotal: row.held_out_total,
      // `numeric` reads back as a string, and `Number(null)` is 0 — which is
      // the one value this column must never invent.
      deltaPp: row.delta_pp === null ? null : Number(row.delta_pp),
      ...(row.changed_lines === null ? {} : { changedLines: row.changed_lines }),
    }));
  });
}

export function formatCriteria(result: CriteriaStatus): string {
  const lines = [
    `${result.summary.workItemId}: ${String(result.visible.length)} visible criteria, ` +
      `${String(result.summary.count)} held out`,
    '',
    formatHeldOutDelta(result.delta),
  ];

  if (result.summary.count === 0) {
    lines.push(
      '',
      'No held-out criteria. Every check this item is graded on is one the agent',
      'implementing it can read and edit — so whether the work satisfies the spec',
      'is currently not measurable, only assertable.',
      '',
      `  sdlc criteria hold-out ${result.summary.workItemId} "<what a real use would need>"`,
    );
  }

  if (result.changedLines > 0) {
    lines.push(
      '',
      `Change size ${String(result.changedLines)} lines predicts a gap of about ` +
        `${String(result.expectedGapPp)}pp (SpecBench, ~27pp per 10× LOC).`,
    );
    if (result.delta.deltaPp !== null && result.delta.deltaPp > result.expectedGapPp) {
      lines.push(
        `  The observed ${String(result.delta.deltaPp)}pp is worse than that, which is the`,
        '  case worth looking at rather than the case worth explaining away.',
      );
    }
  }

  return lines.join('\n');
}

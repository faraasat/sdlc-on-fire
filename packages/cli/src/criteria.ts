import {
  admitHeldOut,
  formatHeldOutDelta,
  heldOutDelta,
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
    };
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

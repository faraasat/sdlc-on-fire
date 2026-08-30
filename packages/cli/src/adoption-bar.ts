import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  admitBlockOutcome,
  BLOCK_OUTCOMES,
  latestTags,
  type BlockOutcome,
  type BlockOutcomeTag,
  type GateResult,
} from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { findActor } from './access.js';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc gates tag` — the write path the adoption bar assumes (P8-BAR-01).
 *
 * [ADR-0063] calls the adoption bar *"the metric that actually decides
 * success"* and `metrics.md` §3a specifies it in five signals. Until this
 * command existed **not one of them had a writer**: the words `valuable` and
 * `nuisance` appeared nowhere in the product outside a code comment. A metric
 * with a specification, a rationale and no write path is a read path with no
 * writer — the shape this build has now found twelve times, arrived at here by
 * the least excusable route, since this one decides whether the product works.
 *
 * The command is deliberately tiny. All the judgement lives in
 * `admitBlockOutcome`, and all the enforcement lives in two database triggers,
 * so this file is the part that can be wrong without the rule being wrong.
 */

const exec = promisify(execFile);

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

export const TAG_ACTION = 'GATE_OUTCOME_TAGGED';

export interface TagBlockResult {
  readonly recorded: boolean;
  readonly gateId: number;
  readonly workItemId: string | null;
  readonly gateName: string | null;
  readonly outcome: string;
  readonly actor: string | null;
  /** Present when nothing was written. Never a bare boolean — see the refusal vocabulary. */
  readonly refusal?: string;
  readonly because?: string;
  /** A prior tag by the same actor on the same gate, when this one supersedes it. */
  readonly supersedes?: { readonly outcome: string; readonly taggedAt: string };
}

/**
 * Records a person's judgement of a block.
 *
 * The actor is resolved from `git config user.email` unless `--as` names
 * somebody, and **no role is required**: any human who was stopped may say
 * whether it was worth it. Requiring a role here would restrict the measure to
 * approvers, which is precisely the population whose opinion of gate friction
 * is least representative.
 */
export async function tagBlockOutcome(
  root: string,
  gateId: number,
  outcome: string,
  options: { readonly reason?: string | undefined; readonly as?: string | undefined } = {},
): Promise<TagBlockResult> {
  return withDb(root, async (db) => {
    const gates = await db.query<{
      result: string | null;
      work_item_id: string;
      gate_name: string;
    }>('SELECT result, work_item_id, gate_name FROM gates WHERE id = $1;', [gateId]);
    const gate = gates[0];
    if (gate === undefined) {
      return {
        recorded: false,
        gateId,
        workItemId: null,
        gateName: null,
        outcome,
        actor: null,
        refusal: 'gate-not-found',
        because: `no gate with id ${String(gateId)} — \`sdlc gates list\` shows what exists`,
      };
    }

    const reference =
      options.as ??
      (await exec('git', ['config', 'user.email'], { cwd: root })
        .then((result) => result.stdout.trim())
        .catch(() => ''));
    const actor = reference === '' ? null : await findActor(db, reference);
    if (actor === null) {
      return {
        recorded: false,
        gateId,
        workItemId: gate.work_item_id,
        gateName: gate.gate_name,
        outcome,
        actor: null,
        refusal: 'no-actor',
        because:
          reference === ''
            ? 'nobody to attribute this to — `git config user.email` is unset and no --as was given'
            : `no actor matches ${reference} — try \`sdlc access whoami\``,
      };
    }

    const admitted = admitBlockOutcome({
      gateId,
      gateResult: (gate.result ?? 'pending') as GateResult,
      actor: { id: actor.id, kind: actor.kind, displayName: actor.displayName },
      outcome,
      reason: options.reason ?? null,
      now: new Date(),
    });
    if (!admitted.ok) {
      return {
        recorded: false,
        gateId,
        workItemId: gate.work_item_id,
        gateName: gate.gate_name,
        outcome,
        actor: actor.displayName,
        refusal: admitted.refusal,
        because: admitted.because,
      };
    }

    // Read the prior tag *before* writing, so the response can say what this one
    // supersedes. A changed mind is the interesting case for gate calibration
    // and it is invisible if the report only ever shows the winner.
    const prior = await db.query<{ outcome: string; tagged_at: Date | string }>(
      `SELECT outcome, tagged_at FROM gate_outcome_tags
        WHERE gate_id = $1 AND actor_id = $2 ORDER BY tagged_at DESC LIMIT 1;`,
      [gateId, actor.id],
    );

    await db.query(
      `INSERT INTO gate_outcome_tags (gate_id, actor_id, outcome, reason, tagged_at)
       VALUES ($1,$2,$3,$4,$5::timestamptz);`,
      [gateId, actor.id, admitted.tag.outcome, admitted.tag.reason, admitted.tag.taggedAt],
    );

    const port = await PostgresStorageAdapter.create(db);
    await port.appendAudit({
      action: TAG_ACTION,
      actorId: actor.id,
      targetType: 'gate',
      targetId: String(gateId),
      detail: {
        outcome: admitted.tag.outcome,
        reason: admitted.tag.reason,
        workItemId: gate.work_item_id,
        gateName: gate.gate_name,
      },
    });

    const previous = prior[0];
    return {
      recorded: true,
      gateId,
      workItemId: gate.work_item_id,
      gateName: gate.gate_name,
      outcome: admitted.tag.outcome,
      actor: actor.displayName,
      ...(previous === undefined
        ? {}
        : {
            supersedes: {
              outcome: previous.outcome,
              taggedAt: new Date(previous.tagged_at).toISOString(),
            },
          }),
    };
  });
}

export function formatTagResult(result: TagBlockResult): string {
  if (!result.recorded) {
    return `not recorded — ${result.because ?? result.refusal ?? 'refused'}`;
  }
  const where =
    result.workItemId === null
      ? `gate ${String(result.gateId)}`
      : `${result.workItemId} · ${result.gateName ?? ''}`;
  const changed =
    result.supersedes === undefined
      ? ''
      : `\n  supersedes your earlier "${result.supersedes.outcome}" from ${result.supersedes.taggedAt}`;
  return `tagged ${where} as ${result.outcome} (${result.actor ?? 'unknown'})${changed}`;
}

/** Every tag on record, for the report to reduce. */
export async function readBlockTags(root: string): Promise<readonly BlockOutcomeTag[]> {
  return withDb(root, async (db) => {
    const rows = await db.query<{
      gate_id: number;
      actor_id: string;
      outcome: string;
      reason: string | null;
      tagged_at: Date | string;
    }>('SELECT gate_id, actor_id, outcome, reason, tagged_at FROM gate_outcome_tags ORDER BY id;');
    return rows.map((row) => ({
      gateId: Number(row.gate_id),
      actorId: row.actor_id,
      outcome: row.outcome as BlockOutcome,
      reason: row.reason,
      taggedAt: new Date(row.tagged_at).toISOString(),
    }));
  });
}

export { BLOCK_OUTCOMES, latestTags };

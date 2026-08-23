/**
 * Agent-run records (P6-WRITEPATH-01).
 *
 * The `runs` table has existed since the first migration, `/api/runs` serves it
 * and returns `200`, and the UI can query it. Nothing has ever inserted a row.
 * The 2026-08-23 feature audit found it: a complete schema and read path over a
 * permanently empty table, which is worse than a missing feature because it
 * looks finished — the viewer renders an empty list forever and nothing errors.
 *
 * Three rules, each one a way run recording is usually got wrong:
 *
 * 1. **The row is written before the work starts, not after.** A record written
 *    on completion never exists for a dispatch that hung, crashed, or was
 *    killed — and those are precisely the runs somebody needs to look at. A run
 *    begins life as `running` and is updated; it does not spring into existence
 *    already finished.
 *
 * 2. **The finishing write happens on the failure path too.** Otherwise every
 *    failed run stays `running` forever, and "currently running" silently comes
 *    to mean "started at some point since the beginning of time".
 *
 * 3. **A recording failure never fails the dispatch.** Telemetry that can break
 *    the actual work is worse than no telemetry. But it is *reported* rather
 *    than swallowed — a recorder that quietly does nothing is how the table got
 *    empty in the first place, and a silent catch would rebuild that exact
 *    failure with more code.
 */

import { RunSchema, type RunStatus } from './run.js';

/**
 * Statuses a run can *end* on. `RunStatus` and its schema already live in
 * `run.ts` and are imported rather than restated — this repository has three
 * times found two copies of a vocabulary that had never been in the same room
 * (the role registry, the MCP package names, the comment-effect roles), and
 * each time the copies agreed right up until they did not.
 */
export type RunOutcome = Exclude<RunStatus, 'pending' | 'running'>;

/** A run as it begins. `status` is always `running` at this point. */
export interface RunStart {
  readonly id: string;
  readonly workItemId: string;
  readonly skillId?: string | undefined;
  readonly agentTarget?: string | undefined;
  readonly model?: string | undefined;
  readonly contextPackPath?: string | undefined;
  /** ISO instant. Passed in rather than taken from a clock here, so it is testable. */
  readonly startedAt: string;
}

/** How a run ended. */
export interface RunFinish {
  readonly id: string;
  readonly status: RunOutcome;
  readonly finishedAt: string;
  readonly prUrl?: string | undefined;
}

/**
 * Where run rows go.
 *
 * Deliberately narrow, and deliberately not `StoragePort` itself: `dispatchSkill`
 * lives in `agent-manager`, which must not learn about databases to record that
 * it ran. The database-backed implementation satisfies this interface.
 */
export interface RunRecorder {
  start(run: RunStart): Promise<void>;
  finish(run: RunFinish): Promise<void>;
}

/**
 * Map a dispatch outcome onto a run status.
 *
 * `fail` and `error` are kept apart on purpose. A run whose *work* failed —
 * the agent produced something and it did not pass — is an ordinary outcome
 * worth counting. A run that could not execute at all is an operational
 * problem. Collapsing them makes a broken transport look like a low-quality
 * agent, and the fix for those two is nothing alike.
 */
export function runStatusFor(outcome: {
  threw: boolean;
  exitCode?: number | undefined;
}): RunOutcome {
  if (outcome.threw) return 'error';
  return outcome.exitCode === 0 ? 'pass' : 'fail';
}

/**
 * A recorder that reports its own failures instead of hiding them.
 *
 * Wraps any recorder so a write that throws cannot take the dispatch down with
 * it — but calls `onProblem`, so a recorder that has stopped working is visible
 * rather than merely quiet.
 */
export function tolerantRecorder(
  inner: RunRecorder,
  onProblem: (stage: 'start' | 'finish', because: string) => void,
): RunRecorder {
  const describe = (cause: unknown): string =>
    cause instanceof Error ? cause.message : String(cause);
  return {
    async start(run) {
      try {
        await inner.start(run);
      } catch (cause) {
        onProblem('start', describe(cause));
      }
    },
    async finish(run) {
      try {
        await inner.finish(run);
      } catch (cause) {
        onProblem('finish', describe(cause));
      }
    },
  };
}

/**
 * The row a start becomes, validated by the schema that already governs runs.
 *
 * Going through `RunSchema` rather than writing the columns directly means the
 * invariants it already encodes — no finish without a start, no finish before
 * the start, no terminal status without a finish time — apply to rows this
 * recorder produces. They were written for readers and nothing had ever
 * written a row for them to check.
 */
export function startRow(run: RunStart): unknown {
  return RunSchema.parse({
    id: run.id,
    work_item_id: run.workItemId,
    skill_id: run.skillId ?? null,
    agent_target: run.agentTarget ?? null,
    model: run.model ?? null,
    context_pack_path: run.contextPackPath ?? null,
    status: 'running',
    started_at: run.startedAt,
    finished_at: null,
  });
}

/**
 * Where a run's context-pack audit copy lives (P6-WRITEPATH-03).
 *
 * The convention was already written down — `run.ts` documents
 * `.sdlc/context/packs/<run-id>.md` in the `context_pack_path` field — and
 * nothing produced one, so the column and the comment described a file that
 * never existed. Same shape as the `runs` table itself: the reader was built
 * and the writer was not.
 *
 * Returned **relative to the workspace root**, because the value is stored in
 * a database that a second machine will read. An absolute path in that column
 * is correct exactly once, on the machine that wrote it.
 */
export function contextPackPath(runId: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(runId)) {
    // A run id reaches a filesystem path here. Rejecting the shape is cheaper
    // than sanitising it: a `..` or a slash silently redirects the write, and
    // an audit copy written somewhere other than where the record says it is
    // is worse than no audit copy.
    throw new Error(`unsafe run id for a pack path: ${JSON.stringify(runId)}`);
  }
  return `.sdlc/context/packs/${runId}.md`;
}

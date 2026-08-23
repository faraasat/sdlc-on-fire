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

/**
 * Why a run did not succeed (P6-INSTRUMENT-02, FEAT-MET-010).
 *
 * **Closed, and derived from what actually threw** — never free text, and never
 * the agent's own account of its failure. A model asked why it failed writes a
 * fluent sentence, and a hundred fluent sentences do not group; the whole value
 * of this field is that it can be counted.
 *
 * The split that matters is `output-contract` versus `forbidden-claim`. Both are
 * a schema rejection at the same boundary, and they mean opposite things: the
 * first is a model that could not produce the shape, the second is a model that
 * tried to certify its own work. One is a prompt problem and the other is the
 * thing this product exists to prevent, and a single "invalid output" bucket
 * would hide the second inside the first.
 */
export const RUN_FAILURE_REASONS = [
  'output-contract',
  'forbidden-claim',
  'transport',
  'timeout',
  'depth-cap',
] as const;
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number];

/**
 * What a dispatch cost, as the transport reported it (FEAT-MET-008).
 *
 * Every field optional and left absent rather than zeroed. A cost of 0 because
 * nothing was recorded and one because nothing was spent render identically, and
 * one of them is wrong — the same rule the DORA report already follows.
 *
 * Cost is **recorded, not computed**. The obvious implementation is a per-model
 * price table times token counts, and it decays: prices change on the vendor's
 * schedule and a stale table reports a confident number that is quietly false.
 * The Claude CLI already returns `total_cost_usd` per invocation.
 */
export interface RunUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly costUsd?: number | undefined;
  /**
   * Prompt-cache accounting (P6-INSTRUMENT-03, FEAT-MET-011).
   *
   * The **rate**, not the cacheable fraction. `packMetrics.cacheableFraction`
   * already reports how much of a pack *could* be cached, which is a property of
   * how the pack was ordered and is knowable without ever running anything.
   * Whether it *was* cached is only knowable from what the provider says it
   * read, and those two numbers diverging is the entire point — a pack that is
   * 80% cacheable and never hits is a stable prefix that keeps changing.
   */
  readonly cacheReadTokens?: number | undefined;
  readonly cacheCreationTokens?: number | undefined;
  /**
   * Turns in the agentic loop (FEAT-MET-013).
   *
   * Not tool calls, and deliberately not named as though it were. Tool calls
   * need `--output-format stream-json`; `json` reports turns, and reporting
   * turns under the name "tool calls" would be a substitution nobody could see
   * in a dashboard.
   */
  readonly turns?: number | undefined;
}

/** How a run ended. */
export interface RunFinish {
  readonly id: string;
  readonly status: RunOutcome;
  readonly finishedAt: string;
  readonly prUrl?: string | undefined;
  /** Only on `fail`/`error`. A reason on a passing run is a contradiction. */
  readonly failureReason?: RunFailureReason | undefined;
  readonly usage?: RunUsage | undefined;
}

/**
 * Classifies a thrown dispatch failure.
 *
 * Keyed on the error's `name` rather than on `instanceof`: the error classes
 * live in `agent-manager`, this is `core`, and making core depend on the layer
 * above it to name a failure would invert the dependency for a string compare.
 * The names are stable — they are the `override readonly name` on each class.
 */
export function failureReasonFor(cause: unknown): RunFailureReason {
  const error = cause as { name?: unknown; message?: unknown };
  const name = typeof error?.name === 'string' ? error.name : '';
  const message = typeof error?.message === 'string' ? error.message : '';

  if (name === 'OutputContractError') {
    // The forbidden-field guard produces this exact phrase, and it is the one
    // rejection that means the agent tried to certify its own work.
    return /claims verification results/.test(message) ? 'forbidden-claim' : 'output-contract';
  }
  if (/depth/i.test(message) && /(?:cap|limit|exceed)/i.test(message)) return 'depth-cap';
  // Node reports a killed child as ETIMEDOUT / SIGTERM; the transport's own
  // timeout says so in words. Checked before `transport`, since a timeout is a
  // transport failure and the more specific answer is the useful one.
  if (/timed? ?out|ETIMEDOUT|SIGTERM/i.test(message)) return 'timeout';
  return 'transport';
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

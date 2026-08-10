import { createHash } from 'node:crypto';

/**
 * Checkpoint and resume for stage-agent runs (P1-AGENT-05, ADR-0022/0039).
 *
 * A daemon dies mid-run: laptop sleep, `kill -9`, OOM. The run was inside a git
 * worktree, several steps in, and some of those steps changed the world. The
 * question on restart is not "where did we get to" — the log answers that — but
 * **"is the log telling the truth."**
 *
 * That distinction is the whole module. A checkpoint saying step 7 committed is
 * a *claim*, written by the same process that then crashed, and this product
 * does not resume on claims any more than it gates on them. So resume
 * reconciles the log against the worktree's actual HEAD before deciding where
 * to start, and a step whose claimed effect is not in the world is re-run rather
 * than skipped.
 *
 * **Semantic, not per-turn** (ADR-0039). Only a step that mutated state is a
 * valid recovery point. Checkpointing every turn spends most of its I/O on rows
 * nothing will ever resume from, and — worse — invites resuming from "the last
 * turn", which restores a model to the middle of its own reasoning.
 */

export type StepStatus = 'in_progress' | 'complete' | 'failed';

export interface Checkpoint {
  readonly runId: string;
  /** Assigned before the step runs, so a step that died still has an identity. */
  readonly stepIdentity: string;
  readonly stepSeq: number;
  readonly stepType: string;
  /** Only `true` rows are valid recovery points (ADR-0039). */
  readonly mutatesState: boolean;
  readonly contentHash: string;
  /** HEAD when the checkpoint was taken, for reconciliation against reality. */
  readonly gitSha?: string | undefined;
  readonly status: StepStatus;
  readonly createdAt: string;
}

/**
 * A step's identity, minted from what the step *is* rather than when it ran.
 *
 * Stable across attempts on purpose: a retry has to land on the same row, or
 * the sequence a resume walks contains the same step twice and the reconciler
 * cannot tell a retry from a second action.
 */
export function stepIdentity(input: {
  readonly runId: string;
  readonly stepSeq: number;
  readonly stepType: string;
}): string {
  return createHash('sha256')
    .update(`${input.runId}:${String(input.stepSeq)}:${input.stepType}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** What the world actually looks like now — supplied by the caller, never assumed. */
export interface WorldState {
  /** Current HEAD of the run's worktree, or undefined when there is no repo. */
  readonly headSha?: string | undefined;
  /** Whether the worktree still exists at all. */
  readonly worktreePresent: boolean;
}

export type ResumeDecision =
  | { readonly action: 'start-fresh'; readonly reason: string }
  | { readonly action: 'resume'; readonly fromSeq: number; readonly reason: string }
  | { readonly action: 'needs-human'; readonly reason: string };

/**
 * Decides where a crashed run picks up.
 *
 * Pure: the log and the world both arrive as arguments, so the decision is
 * reproducible from what was recorded — the same property that makes a gate
 * verdict replayable rather than a story about one.
 *
 * The order encodes what is safe to assume. A missing worktree is escalated
 * before anything else, because every other branch reasons about a tree that
 * would not be there.
 */
export function decideResume(
  checkpoints: readonly Checkpoint[],
  world: WorldState,
): ResumeDecision {
  if (!world.worktreePresent) {
    return {
      action: 'needs-human',
      // Re-creating it would produce a tree whose relationship to the recorded
      // steps is unknown, and the steps claim to have changed a tree.
      reason:
        'the run’s worktree is gone — its recorded steps describe a tree that no longer exists',
    };
  }

  const ordered = [...checkpoints].sort((a, b) => a.stepSeq - b.stepSeq);
  if (ordered.length === 0) {
    return { action: 'start-fresh', reason: 'no checkpoints recorded for this run' };
  }

  const failed = ordered.find((entry) => entry.status === 'failed');
  if (failed !== undefined) {
    return {
      action: 'needs-human',
      reason: `step ${String(failed.stepSeq)} (${failed.stepType}) failed — resuming past a failure would build on it`,
    };
  }

  // Only state-mutating steps are recovery points. Resuming from a step that
  // changed nothing restores a model to the middle of its own reasoning, which
  // ADR-0039 names as the self-conditioning failure.
  const anchors = ordered.filter((entry) => entry.mutatesState && entry.status === 'complete');
  if (anchors.length === 0) {
    return {
      action: 'start-fresh',
      reason: 'nothing recorded has mutated state, so there is nothing to preserve',
    };
  }

  const latest = anchors[anchors.length - 1] as Checkpoint;

  // The reconciliation. The checkpoint says HEAD was X; if HEAD is not X, the
  // commit that step claims to have made is not in the world, and the step has
  // to run again rather than be skipped.
  if (latest.gitSha !== undefined && world.headSha !== latest.gitSha) {
    const earlier = anchors
      .slice(0, -1)
      .reverse()
      .find((entry) => entry.gitSha === undefined || entry.gitSha === world.headSha);
    if (earlier === undefined) {
      return {
        action: 'needs-human',
        reason:
          `the log's last state-changing step claims HEAD ${latest.gitSha.slice(0, 8)} and the ` +
          `worktree is at ${(world.headSha ?? '(none)').slice(0, 8)} — no recorded step matches ` +
          'what is actually there',
      };
    }
    return {
      action: 'resume',
      fromSeq: earlier.stepSeq + 1,
      reason:
        `step ${String(latest.stepSeq)} claims a commit that is not in the worktree — resuming ` +
        `from the last step whose recorded state matches reality (${String(earlier.stepSeq)})`,
    };
  }

  const inProgress = ordered.find((entry) => entry.status === 'in_progress');
  if (inProgress !== undefined) {
    return {
      action: 'resume',
      // Re-run the interrupted step. Its side effects are guarded by the
      // idempotency key, so re-running is safe and skipping is not.
      fromSeq: inProgress.stepSeq,
      reason: `step ${String(inProgress.stepSeq)} (${inProgress.stepType}) was interrupted — re-running it`,
    };
  }

  return {
    action: 'resume',
    fromSeq: (ordered[ordered.length - 1] as Checkpoint).stepSeq + 1,
    reason: `every recorded step completed and matches the worktree — continuing after step ${String((ordered[ordered.length - 1] as Checkpoint).stepSeq)}`,
  };
}

export interface CheckpointStore {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}

/**
 * Opens a checkpoint before the step runs.
 *
 * Before, not after: a row written on completion records only the steps that
 * finished, and the step that did not finish is the one a resume needs to know
 * about.
 */
export async function openCheckpoint(
  db: CheckpointStore,
  input: {
    readonly runId: string;
    readonly stepSeq: number;
    readonly stepType: string;
    readonly mutatesState: boolean;
    readonly contentHash: string;
    readonly gitSha?: string | undefined;
  },
): Promise<string> {
  const identity = stepIdentity(input);
  await db.query(
    `INSERT INTO checkpoints
       (run_id, step_identity, step_seq, step_type, mutates_state, content_hash, git_sha, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'in_progress')
     ON CONFLICT (run_id, step_identity)
     DO UPDATE SET status = 'in_progress', content_hash = EXCLUDED.content_hash;`,
    [
      input.runId,
      identity,
      input.stepSeq,
      input.stepType,
      input.mutatesState,
      input.contentHash,
      input.gitSha ?? null,
    ],
  );
  return identity;
}

/** Closes a checkpoint with what the world looked like after the step. */
export async function closeCheckpoint(
  db: CheckpointStore,
  input: {
    readonly runId: string;
    readonly stepIdentity: string;
    readonly status: 'complete' | 'failed';
    readonly gitSha?: string | undefined;
    readonly snapshot?: unknown;
  },
): Promise<void> {
  await db.query(
    `UPDATE checkpoints
        SET status = $3, git_sha = COALESCE($4, git_sha), state_snapshot = $5::jsonb
      WHERE run_id = $1 AND step_identity = $2;`,
    [
      input.runId,
      input.stepIdentity,
      input.status,
      input.gitSha ?? null,
      input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
    ],
  );
}

/** Every checkpoint for a run, oldest first. */
export async function checkpointsFor(
  db: CheckpointStore,
  runId: string,
): Promise<readonly Checkpoint[]> {
  const rows = await db.query<{
    run_id: string;
    step_identity: string;
    step_seq: number;
    step_type: string;
    mutates_state: boolean;
    content_hash: string;
    git_sha: string | null;
    status: StepStatus;
    created_at: Date | string;
  }>(
    `SELECT run_id, step_identity, step_seq, step_type, mutates_state, content_hash,
            git_sha, status, created_at
       FROM checkpoints WHERE run_id = $1 ORDER BY step_seq, created_at;`,
    [runId],
  );
  return rows.map((row) => ({
    runId: row.run_id,
    stepIdentity: row.step_identity,
    stepSeq: Number(row.step_seq),
    stepType: row.step_type,
    mutatesState: row.mutates_state === true,
    contentHash: row.content_hash,
    gitSha: row.git_sha ?? undefined,
    status: row.status,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

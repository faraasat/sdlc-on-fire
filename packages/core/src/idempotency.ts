import { createHash } from 'node:crypto';

/**
 * Idempotency keys for side-effecting agent actions (P1-AGENT-04, ADR-0039).
 *
 * The problem this solves is narrow and expensive: a run dies after opening a
 * pull request but before recording that it did. On resume, the naive behaviour
 * is to open a second one. The same shape applies to publishing a release,
 * posting a comment, or firing a webhook — anything the outside world can see.
 *
 * A key is derived from *what the action is*, never from when it ran or which
 * process ran it. Two attempts at the same action must produce the same key or
 * the ledger cannot recognise the retry; a timestamp or a run id in the input
 * would guarantee they never match, which is the failure mode that looks like
 * it works right up until a crash.
 */

/** Actions with effects outside our own database. The set is closed on purpose. */
export const SIDE_EFFECTING_ACTIONS = [
  'pr_create',
  'pr_comment',
  'release_publish',
  'webhook_dispatch',
  'branch_push',
] as const;

export type SideEffectingAction = (typeof SIDE_EFFECTING_ACTIONS)[number];

export interface ActionIdentity {
  readonly workItemId: string;
  readonly stage: string;
  readonly action: SideEffectingAction;
  /**
   * What makes this action distinct from another of the same type on the same
   * item — a target branch, a comment body, a release tag. Must be stable
   * across retries: anything varying per attempt breaks recognition.
   */
  readonly input: Record<string, unknown>;
}

/** Stable JSON: key order must not change the key, or a retry looks like a new action. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

/**
 * Derives the key.
 *
 * Deliberately excludes attempt number, timestamp, actor and run id. Including
 * any of them would make every retry a fresh key — the ledger would fill up and
 * never once prevent a duplicate.
 */
export function idempotencyKey(identity: ActionIdentity): string {
  return createHash('sha256')
    .update(
      canonical({
        workItemId: identity.workItemId,
        stage: identity.stage,
        action: identity.action,
        input: identity.input,
      }),
      'utf8',
    )
    .digest('hex');
}

/** Whether an action needs ledger protection at all. */
export function isSideEffecting(action: string): action is SideEffectingAction {
  return (SIDE_EFFECTING_ACTIONS as readonly string[]).includes(action);
}

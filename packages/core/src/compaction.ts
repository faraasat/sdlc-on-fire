import type { RunContextAccount, TurnAccounting } from './context-horizon.js';

/**
 * Bounded compaction against a declared budget (P7-HORIZON-02).
 *
 * [P7-HORIZON-01] made accumulated context measurable. A measurement nothing
 * acts on is a dashboard, so this is the acting: a per-run ceiling, and a
 * compaction step that fires when the run crosses it.
 *
 * Three properties, each of which is a way compaction turns into forgetting.
 *
 * **Selection is deterministic and no model participates** (ADR-0040). The plan
 * is "which turns fall outside the retained window", computed by arithmetic. A
 * model may afterwards be asked to *summarise* what was dropped; it is never
 * asked which turns to drop, because a model choosing what it may forget is a
 * model grading its own memory.
 *
 * **What was dropped is recorded.** That is the whole difference between
 * compaction and forgetting. An agent whose context was trimmed with no trace
 * produces output nobody can account for — a reviewer sees a decision made
 * without the information that would explain it, and no way to discover the
 * information was ever there.
 *
 * **Some turns are pinned and never dropped.** The first turn carries the task;
 * the most recent carry the state the run is acting on. Dropping either is how
 * a compacted agent forgets what it was doing while continuing to sound
 * confident about it.
 */

/** Recent turns kept whatever the budget says. */
export const DEFAULT_RETAIN_RECENT = 3;

/**
 * Fires at this share of the budget, not at 100%.
 *
 * Compacting exactly at the ceiling means the turn that crosses it has already
 * been assembled and sent — the budget is enforced one turn after it was
 * exceeded. A margin makes the ceiling the thing that is not crossed rather
 * than the thing that is noticed.
 */
export const DEFAULT_COMPACT_AT = 0.8;

export interface CompactionOptions {
  /** Recent turns to keep. The first turn is pinned separately and always. */
  readonly retainRecent?: number | undefined;
  /** Share of the budget at which compaction fires. */
  readonly compactAt?: number | undefined;
}

export type CompactionRefusal = 'under-threshold' | 'nothing-droppable' | 'no-budget' | 'no-turns';

export interface CompactionPlan {
  readonly runId: string;
  readonly fired: boolean;
  readonly budgetTokens: number;
  readonly accumulatedBefore: number;
  /** The level at which it fires — budget × compactAt. */
  readonly thresholdTokens: number;
  /** Turn numbers to drop, oldest first. */
  readonly droppedTurns: readonly number[];
  /** Turn numbers kept, in order. Recorded because it is not derivable later. */
  readonly retainedTurns: readonly number[];
  readonly freedTokens: number;
  /** What remains after the drop. */
  readonly accumulatedAfter: number;
  readonly refusal?: CompactionRefusal | undefined;
  readonly reason: string;
}

function turnTotal(turn: TurnAccounting): number {
  return turn.inputTokens + (turn.cacheReadTokens ?? 0) + turn.outputTokens;
}

/**
 * Plans a compaction. Pure: decides, drops nothing.
 *
 * Returns a plan even when it will not fire, and says why. "Compaction did not
 * happen" and "compaction was not needed" are different facts, and a function
 * that returned nothing for both would make the first invisible.
 */
export function planCompaction(
  account: RunContextAccount,
  turns: readonly TurnAccounting[],
  budgetTokens: number,
  options: CompactionOptions = {},
): CompactionPlan {
  const retainRecent = Math.max(0, options.retainRecent ?? DEFAULT_RETAIN_RECENT);
  const compactAt = options.compactAt ?? DEFAULT_COMPACT_AT;
  const thresholdTokens = Math.floor(budgetTokens * compactAt);
  const ordered = [...turns].sort((a, b) => a.turn - b.turn);

  const base = {
    runId: account.runId,
    budgetTokens,
    accumulatedBefore: account.accumulated,
    thresholdTokens,
    droppedTurns: [] as readonly number[],
    retainedTurns: ordered.map((turn) => turn.turn),
    freedTokens: 0,
    accumulatedAfter: account.accumulated,
  };

  if (budgetTokens <= 0) {
    return {
      ...base,
      fired: false,
      refusal: 'no-budget',
      reason:
        'no run budget declared — compaction with no ceiling is trimming for its own sake, and there is nothing to trim toward',
    };
  }
  if (ordered.length === 0) {
    return { ...base, fired: false, refusal: 'no-turns', reason: 'no turns to compact' };
  }
  if (account.accumulated < thresholdTokens) {
    return {
      ...base,
      fired: false,
      refusal: 'under-threshold',
      reason: `${String(account.accumulated)} of ${String(budgetTokens)} tokens — under the ${String(thresholdTokens)} threshold`,
    };
  }

  // The first turn carries the task; the last `retainRecent` carry the state
  // the run is acting on. Everything between them is the droppable middle.
  const pinnedFirst = ordered[0];
  const recentFrom = Math.max(1, ordered.length - retainRecent);
  const droppable = ordered.slice(1, recentFrom);

  if (droppable.length === 0) {
    return {
      ...base,
      fired: false,
      refusal: 'nothing-droppable',
      reason:
        `over budget with nothing droppable — every turn is pinned (the first, plus the ${String(retainRecent)} most recent). ` +
        'Compaction cannot help here, and pretending it did would hide a run that needs a smaller task rather than a smaller context.',
    };
  }

  const dropped: number[] = [];
  let freed = 0;
  // Oldest first, and only as far as the threshold. Dropping everything
  // droppable would free more than asked and throw away context the run was
  // still under budget with.
  for (const turn of droppable) {
    if (account.accumulated - freed <= thresholdTokens) break;
    dropped.push(turn.turn);
    freed += turnTotal(turn);
  }

  const droppedSet = new Set(dropped);
  return {
    ...base,
    fired: dropped.length > 0,
    droppedTurns: dropped,
    retainedTurns: ordered.map((turn) => turn.turn).filter((number) => !droppedSet.has(number)),
    freedTokens: freed,
    accumulatedAfter: account.accumulated - freed,
    reason:
      dropped.length === 0
        ? 'nothing needed dropping to get under the threshold'
        : `dropped ${String(dropped.length)} turn(s) to free ${String(freed)} tokens, keeping turn ${String(pinnedFirst?.turn ?? 1)} and the ${String(retainRecent)} most recent`,
  };
}

export function formatCompactionPlan(plan: CompactionPlan): string {
  if (!plan.fired) {
    return `${plan.runId}: no compaction — ${plan.reason}`;
  }
  return [
    `${plan.runId}: compacted`,
    `  ${String(plan.accumulatedBefore)} → ${String(plan.accumulatedAfter)} tokens (budget ${String(plan.budgetTokens)}, threshold ${String(plan.thresholdTokens)})`,
    `  dropped turns: ${plan.droppedTurns.join(', ')}`,
    `  kept turns: ${plan.retainedTurns.join(', ')}`,
    '',
    '  What was dropped is recorded, not discarded — a trim that leaves no',
    '  trace produces output nobody can account for.',
  ].join('\n');
}

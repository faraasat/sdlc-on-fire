import type { RunContextAccount } from './context-horizon.js';

/**
 * The signal that a run has gone past the point its context is useful
 * (P7-HORIZON-03).
 *
 * Today this is inferred by a human, from bad output, some time after the fact —
 * which is the worst possible detector for it. A long unattended run degrades
 * gradually and stays fluent throughout: the output keeps reading like work, and
 * what changes is that it stops being about the task. By the time somebody
 * notices, the run has produced hours of it.
 *
 * So: **named tripwires with declared thresholds, not a score.** A single
 * confidence number would be a thing to argue with; a fired tripwire is a thing
 * to act on, and it says which one and why. It is also the only form the
 * disposer rule permits — each of these is arithmetic over recorded facts
 * (ADR-0040), and none of them asks a model how the run is feeling.
 *
 * **Unmeasured is a state, and it is not "healthy".** A run with no accounting
 * has not passed any tripwire because nothing was watching, and reporting that
 * as fine is how a signal becomes decoration.
 */

export const DEGRADATION_SIGNALS = [
  /** Accumulated context is past the declared ceiling. */
  'over-budget',
  /** Compaction has fired repeatedly — each firing is context this run no longer has. */
  'repeatedly-compacted',
  /** Every turn is bigger than the last, so the ceiling is arriving faster than linearly. */
  'accelerating',
  /** The run has taken more turns than a task of this shape should need. */
  'turn-count',
] as const;
export type DegradationSignal = (typeof DEGRADATION_SIGNALS)[number];

/**
 * Thresholds, named rather than buried.
 *
 * Every one of these is a judgement, and a judgement in a constant is one
 * somebody can argue with and change. The same judgement inlined in a
 * comparison is one nobody can find.
 */
export const DEGRADATION_THRESHOLDS = {
  /** More than this many compactions means the run is running on what survived. */
  compactions: 3,
  /** Turns beyond this are past what any single task should need unattended. */
  turns: 40,
  /**
   * A last turn this many times the mean turn is growth, not variance.
   *
   * Compared against the **mean turn size**, not against the growth rate: a
   * rate and a level are different quantities, and comparing them produces a
   * check that never fires on a real ramp — which is how the first version of
   * this went out.
   */
  accelerationRatio: 1.5,
} as const;

export interface FiredSignal {
  readonly signal: DegradationSignal;
  readonly because: string;
  /** What to do about it. A signal with no next step is an alarm nobody silences. */
  readonly remedy: string;
}

export interface DegradationVerdict {
  readonly runId: string;
  /** True when at least one tripwire fired. */
  readonly degraded: boolean;
  readonly fired: readonly FiredSignal[];
  /** No accounting to judge — distinct from "judged and fine". */
  readonly measured: boolean;
  readonly because: string;
}

export interface DegradationInput {
  readonly account: RunContextAccount;
  /** The declared ceiling. Zero means undeclared, and the budget tripwire cannot fire. */
  readonly budgetTokens: number;
  /** How many times compaction has fired on this run. */
  readonly compactions: number;
}

/**
 * Evaluates every tripwire. Pure.
 *
 * All of them, not the first: a run that is over budget *and* accelerating is a
 * different situation from one that is merely over budget, and short-circuiting
 * would hide the difference behind whichever check happened to be first.
 */
export function assessDegradation(input: DegradationInput): DegradationVerdict {
  const { account, budgetTokens, compactions } = input;
  const fired: FiredSignal[] = [];

  if (account.turns === 0) {
    return {
      runId: account.runId,
      degraded: false,
      fired: [],
      measured: false,
      because:
        'no per-turn accounting for this run — nothing was watching, which is not the same as nothing being wrong',
    };
  }

  if (budgetTokens > 0 && account.accumulated > budgetTokens) {
    fired.push({
      signal: 'over-budget',
      because: `${String(account.accumulated)} tokens accumulated against a ${String(budgetTokens)} ceiling`,
      remedy:
        'compaction has already had its chance at this point — split the work item rather than raising the ceiling',
    });
  }

  if (compactions > DEGRADATION_THRESHOLDS.compactions) {
    fired.push({
      signal: 'repeatedly-compacted',
      because: `compaction fired ${String(compactions)} times`,
      remedy:
        'each firing is context this run no longer has; the answer is a smaller task, not another trim',
    });
  }

  // No `turns > 1` clause, deliberately: with a single turn `lastTurn` and
  // `perTurn` are the same number, so the ratio is 1 and this can never fire.
  // A guard nothing can reach is a guard nothing keeps honest.
  if (
    account.perTurn !== null &&
    account.perTurn > 0 &&
    account.lastTurn > account.perTurn * DEGRADATION_THRESHOLDS.accelerationRatio
  ) {
    fired.push({
      signal: 'accelerating',
      because: `the last turn was ${String(account.lastTurn)} tokens against a ${String(account.perTurn)} mean — the ceiling is arriving faster than linearly`,
      remedy:
        'check what each turn is pulling in; a growing pack usually means a retrieval that stopped narrowing',
    });
  }

  if (account.turns > DEGRADATION_THRESHOLDS.turns) {
    fired.push({
      signal: 'turn-count',
      because: `${String(account.turns)} turns`,
      remedy:
        'past what a single task should need unattended — check the run is still working on the thing it started on',
    });
  }

  return {
    runId: account.runId,
    degraded: fired.length > 0,
    fired,
    measured: true,
    because:
      fired.length === 0
        ? `${String(account.turns)} turns, ${String(account.accumulated)} tokens — no tripwire fired`
        : `${String(fired.length)} tripwire(s) fired`,
  };
}

export function formatDegradation(verdict: DegradationVerdict): string {
  if (!verdict.measured) {
    return `${verdict.runId}: unmeasured — ${verdict.because}`;
  }
  if (!verdict.degraded) {
    return `${verdict.runId}: ok — ${verdict.because}`;
  }
  return [
    `${verdict.runId}: degraded — ${verdict.because}`,
    ...verdict.fired.flatMap((entry) => [
      `  ⚠ ${entry.signal}: ${entry.because}`,
      `      ${entry.remedy}`,
    ]),
    '',
    'This is surfaced rather than left to be inferred from the output. A long run',
    'stays fluent as it degrades — what changes is that it stops being about the',
    'task, and that is not visible in any single turn.',
  ].join('\n');
}

/**
 * In-run context accounting (P7-HORIZON-01, `techniques/42`).
 *
 * Everything this product measures about context measures **one window**:
 * `packMetrics` compares a pack against the budget it was assembled for, and
 * the `runs` row records totals for a run that has already ended. Both are
 * honest and neither answers the question a long unattended session actually
 * raises.
 *
 * The quantity that degrades is **accumulated context within a run** — the
 * total the model has taken in across every turn, not the size of any one of
 * them. A run doing forty turns at 60% window occupancy looks healthy on every
 * per-window metric there is, while having consumed well over a million tokens
 * of context whose earliest half it can no longer act on coherently. Per-window
 * accounting cannot see that, by construction: each window is fine.
 *
 * **Cache reads count.** A turn that re-reads 100k cached tokens is a turn in
 * which the model took in 100k tokens of context; the discount is on the bill,
 * not on the attention. Excluding them would make a well-cached long run look
 * like a short one, which is exactly backwards — caching makes long runs cheap,
 * and cheap long runs are the ones that get left unattended.
 *
 * **Growth is per-turn, and unmeasured below two turns.** One turn has no
 * slope. Reporting it as flat is the reassuring answer, and this whole subsystem
 * exists because a long run's failure mode is that everything reads fine.
 */

export interface TurnAccounting {
  readonly runId: string;
  /** 1-based. The first turn of a run is turn 1. */
  readonly turn: number;
  /** Tokens the provider says it read fresh. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cached tokens the provider read. Context the model saw, at a discount. */
  readonly cacheReadTokens?: number | undefined;
  readonly at?: string | undefined;
}

export interface RunContextAccount {
  readonly runId: string;
  readonly turns: number;
  /** Everything the model took in, cache reads included. */
  readonly accumulatedInput: number;
  readonly accumulatedOutput: number;
  /** `accumulatedInput + accumulatedOutput` — the run's whole context traffic. */
  readonly accumulated: number;
  /** The largest single turn. What a per-window metric would have shown. */
  readonly peakTurn: number;
  /** Mean tokens taken in per turn. */
  readonly perTurn: number | null;
  /**
   * Tokens added per turn, from the first turn to the last.
   *
   * `null` below two turns: one turn has no slope, and calling it flat is the
   * reassuring answer rather than the true one.
   */
  readonly growthPerTurn: number | null;
  /**
   * Share of accumulated input that came from cache.
   *
   * High is not good or bad on its own — it is the number that explains why a
   * run this long was affordable, which is usually why nobody noticed it was
   * this long.
   */
  readonly cachedFraction: number | null;
  readonly because: string;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

function turnTotal(turn: TurnAccounting): number {
  return turn.inputTokens + (turn.cacheReadTokens ?? 0) + turn.outputTokens;
}

/**
 * Accumulates a run's turns.
 *
 * Pure. Turns are sorted by their declared number rather than by arrival:
 * a retried turn arrives out of order and an accumulation that trusted array
 * order would report a growth rate for a sequence that never happened.
 */
export function accountRun(runId: string, turns: readonly TurnAccounting[]): RunContextAccount {
  const ordered = [...turns].sort((a, b) => a.turn - b.turn);

  let accumulatedInput = 0;
  let accumulatedOutput = 0;
  let peakTurn = 0;
  for (const turn of ordered) {
    accumulatedInput += turn.inputTokens + (turn.cacheReadTokens ?? 0);
    accumulatedOutput += turn.outputTokens;
    peakTurn = Math.max(peakTurn, turnTotal(turn));
  }

  const accumulated = accumulatedInput + accumulatedOutput;
  const cacheRead = ordered.reduce((sum, turn) => sum + (turn.cacheReadTokens ?? 0), 0);

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const growthPerTurn =
    ordered.length < 2 || first === undefined || last === undefined
      ? null
      : round((turnTotal(last) - turnTotal(first)) / (ordered.length - 1));

  return {
    runId,
    turns: ordered.length,
    accumulatedInput,
    accumulatedOutput,
    accumulated,
    peakTurn,
    perTurn: ordered.length === 0 ? null : Math.round(accumulated / ordered.length),
    growthPerTurn,
    cachedFraction: accumulatedInput === 0 ? null : round(cacheRead / accumulatedInput),
    because:
      ordered.length === 0
        ? 'no turns recorded — a run with no accounting is unmeasured, not small'
        : ordered.length < 2
          ? 'one turn — there is no growth rate to report from a single point'
          : `${String(ordered.length)} turns took in ${String(accumulated)} tokens; the largest single window was ${String(peakTurn)}`,
  };
}

/**
 * How much larger the accumulated context is than the biggest window.
 *
 * The one number that says whether per-window accounting was misleading: a
 * ratio of 1 means the run was a single call and the window told the whole
 * story, and a ratio of 40 means every per-window metric was reporting on 2.5%
 * of what actually happened.
 */
export function windowBlindnessRatio(account: RunContextAccount): number | null {
  if (account.peakTurn === 0) return null;
  return round(account.accumulated / account.peakTurn);
}

export function formatRunAccount(account: RunContextAccount): string {
  if (account.turns === 0) {
    return `${account.runId}: unmeasured — ${account.because}`;
  }
  const ratio = windowBlindnessRatio(account);
  return [
    `${account.runId}: ${String(account.turns)} turn(s), ${String(account.accumulated)} tokens accumulated`,
    `  in ${String(account.accumulatedInput)} · out ${String(account.accumulatedOutput)} · peak window ${String(account.peakTurn)}`,
    account.growthPerTurn === null
      ? '  growth: unmeasured — one turn has no slope'
      : `  growth: ${account.growthPerTurn > 0 ? '+' : ''}${String(account.growthPerTurn)} tokens/turn`,
    account.cachedFraction === null
      ? '  cached: unmeasured'
      : `  cached: ${String(Math.round(account.cachedFraction * 100))}% of what was read`,
    ratio === null || ratio <= 1
      ? ''
      : `  accumulated context is ${String(ratio)}× the largest window — per-window metrics saw ${String(Math.round((100 / ratio) * 10) / 10)}% of this run`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

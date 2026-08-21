/**
 * WIP limits from Little's Law (P3-KAN-05, `.research/techniques/35` §B).
 *
 * `L = λW` — average work in progress equals arrival rate times average time in
 * system. Rearranged for a Kanban column: if a column completes two cards a day
 * and a card sits there four days, then eight cards is what "full" looks like.
 *
 * The point of deriving it rather than picking a number is that a limit nobody
 * can justify is a limit somebody removes the first time it is inconvenient. A
 * limit that came out of the column's *own* observed throughput and cycle time
 * can be argued with using data, which is the only kind of argument that ends.
 *
 * Two honest limits on this, stated because a formula printed with two decimal
 * places invites more confidence than it earns:
 *
 * - Little's Law assumes a **stable system** — arrivals and departures roughly
 *   in balance over the window. A column that is filling up faster than it
 *   drains gives a number that describes the jam rather than the capacity.
 * - A short window over few cards is noise. The result carries its sample size
 *   so a caller can refuse to act on three data points, and
 *   {@link wipLimitConfidence} says plainly when it should.
 */

export interface ColumnFlow {
  readonly column: string;
  /** Cards that left the column during the window. */
  readonly completed: number;
  /** Mean time a card spent in the column, ms. */
  readonly meanTimeInColumnMs: number;
  readonly windowMs: number;
}

export type WipConfidence = 'none' | 'weak' | 'usable';

export interface WipLimit {
  readonly column: string;
  /** L = λW, rounded up. Null when the inputs cannot support a number. */
  readonly limit: number | null;
  /** λ — completions per millisecond, kept unrounded for the caller's own maths. */
  readonly throughputPerMs: number | null;
  readonly confidence: WipConfidence;
  readonly because: string;
}

/** Below this many completions the number is arithmetic on noise. */
export const MIN_SAMPLE_FOR_WIP = 5;

export function wipLimitConfidence(completed: number): WipConfidence {
  if (completed === 0) return 'none';
  return completed < MIN_SAMPLE_FOR_WIP ? 'weak' : 'usable';
}

/**
 * Derive one column's limit.
 *
 * Rounded **up**, deliberately. A computed limit of 2.3 rounded down to 2 makes
 * the third card a policy violation on a column that demonstrably handles 2.3,
 * and a limit that fires on normal work is a limit people disable.
 *
 * A floor of 1, always: a limit of zero would mean the column may never be
 * used, which is never what the data is saying — it means nothing finished
 * during the window.
 */
export function wipLimitFor(flow: ColumnFlow): WipLimit {
  const confidence = wipLimitConfidence(flow.completed);

  if (flow.windowMs <= 0 || flow.completed === 0) {
    return {
      column: flow.column,
      limit: null,
      throughputPerMs: null,
      confidence: 'none',
      because: 'nothing completed in this column during the window, so there is no rate to use',
    };
  }

  if (flow.meanTimeInColumnMs <= 0) {
    return {
      column: flow.column,
      limit: null,
      throughputPerMs: flow.completed / flow.windowMs,
      confidence: 'none',
      because: 'cards left this column instantly, so time-in-system is not measurable',
    };
  }

  const throughputPerMs = flow.completed / flow.windowMs;
  const limit = Math.max(1, Math.ceil(throughputPerMs * flow.meanTimeInColumnMs));

  return {
    column: flow.column,
    limit,
    throughputPerMs,
    confidence,
    because:
      confidence === 'usable'
        ? `L = λW over ${String(flow.completed)} completions`
        : `only ${String(flow.completed)} completion(s) — this is arithmetic on noise, not a measurement`,
  };
}

export function wipLimits(flows: readonly ColumnFlow[]): readonly WipLimit[] {
  return flows.map(wipLimitFor);
}

export type WipStatus = 'under' | 'at' | 'over' | 'unlimited';

export interface WipCheck {
  readonly column: string;
  readonly current: number;
  readonly limit: number | null;
  readonly status: WipStatus;
  readonly because: string;
}

/**
 * Whether a column is over its limit.
 *
 * A column with no derivable limit is `unlimited`, never `under`. They are
 * different facts: one means there is room, the other means nobody knows, and
 * rendering "nobody knows" as "there is room" is how a WIP limit becomes
 * decoration.
 */
export function checkWip(column: string, current: number, limit: WipLimit | null): WipCheck {
  if (limit === null || limit.limit === null) {
    return {
      column,
      current,
      limit: null,
      status: 'unlimited',
      because: limit?.because ?? 'no limit could be derived for this column',
    };
  }

  const status: WipStatus =
    current > limit.limit ? 'over' : current === limit.limit ? 'at' : 'under';

  return {
    column,
    current,
    limit: limit.limit,
    status,
    because:
      status === 'over'
        ? `${String(current)} cards against a derived limit of ${String(limit.limit)} — ` +
          'the constraint is downstream, and starting more work here will not move it'
        : limit.because,
  };
}

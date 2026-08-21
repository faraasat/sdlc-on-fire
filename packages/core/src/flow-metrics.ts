/**
 * Flow metrics (P3-MET-01, `.research/techniques/35` §B).
 *
 * Value-stream mapping without a workshop. A card's `lifecycle_transitions`
 * rows *are* a value stream map by construction — a timestamped path from
 * intake to done — so the whole of VSM's core artifact is a query away, and
 * none of it needs new instrumentation.
 *
 * The distinction that earns its keep is **wait time versus active time**.
 * Cycle time alone says a card took nine days; it does not say whether that was
 * nine days of work or one day of work and eight days sitting in a queue. Those
 * ask for opposite fixes — hire, or unblock — and a dashboard that cannot tell
 * them apart sends people to optimise the wrong thing, which is Theory of
 * Constraints' entire point.
 */

import type { LifecycleStage } from './lifecycle.js';

export interface TransitionRow {
  readonly work_item_id: string;
  readonly from_state: string | null;
  readonly to_state: string;
  /** ISO timestamp. */
  readonly created_at: string;
}

export interface StageVisit {
  readonly stage: string;
  readonly enteredAt: number;
  /** null while the card is still in this stage. */
  readonly leftAt: number | null;
  readonly ms: number | null;
}

const parse = (iso: string): number => Date.parse(iso);

/**
 * A card's stage visits, in order.
 *
 * A card can re-enter a stage — rework is normal and is exactly what a flow
 * metric should show — so this is a list of *visits*, not a map of stages. A
 * map would silently collapse three trips through `implement` into one and hide
 * the rework that made the card slow.
 */
export function stageVisits(
  transitions: readonly TransitionRow[],
  now: number = Date.now(),
): readonly StageVisit[] {
  const ordered = [...transitions]
    .filter((row) => !Number.isNaN(parse(row.created_at)))
    .sort((a, b) => parse(a.created_at) - parse(b.created_at));

  const visits: StageVisit[] = [];
  for (const [index, row] of ordered.entries()) {
    const enteredAt = parse(row.created_at);
    const next = ordered[index + 1];
    const leftAt = next === undefined ? null : parse(next.created_at);
    visits.push({
      stage: row.to_state,
      enteredAt,
      leftAt,
      // An open visit is measured to `now`. A card that has sat in review for a
      // week is the most interesting row on the board, and reporting it as null
      // duration would drop exactly the cards a bottleneck report is for.
      ms: leftAt === null ? Math.max(0, now - enteredAt) : Math.max(0, leftAt - enteredAt),
    });
  }
  return visits;
}

/** Total time per stage across a set of visits. */
export function stageDurations(visits: readonly StageVisit[]): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const visit of visits) {
    if (visit.ms === null) continue;
    totals.set(visit.stage, (totals.get(visit.stage) ?? 0) + visit.ms);
  }
  return totals;
}

/**
 * Lead time: request to done, queue wait included.
 *
 * Measured from the card's creation, not from its first transition, and that is
 * the whole difference from cycle time. A card created on Monday and picked up
 * on Friday waited four days that the customer experienced and the team did
 * not — dropping it would make the number flattering and useless.
 */
export function leadTime(
  visits: readonly StageVisit[],
  createdAt: string,
  doneStages: readonly string[] = ['done'],
): number | null {
  const created = parse(createdAt);
  if (Number.isNaN(created)) return null;
  const finish = visits.find((visit) => doneStages.includes(visit.stage));
  if (finish === undefined) return null;
  return Math.max(0, finish.enteredAt - created);
}

/** Cycle time: first stage entered to done. Excludes the pre-start queue. */
export function cycleTime(
  visits: readonly StageVisit[],
  doneStages: readonly string[] = ['done'],
): number | null {
  const first = visits[0];
  const finish = visits.find((visit) => doneStages.includes(visit.stage));
  if (first === undefined || finish === undefined) return null;
  return Math.max(0, finish.enteredAt - first.enteredAt);
}

/**
 * Which stages count as work rather than waiting.
 *
 * Declared, not inferred. Whether `approval` is "waiting" is a statement about
 * how a team works, and guessing it from stage names would bake one opinion
 * into everybody's dashboard.
 */
export const DEFAULT_WAIT_STAGES: readonly LifecycleStage[] = [
  'intake',
  'triage',
  'review',
  'security_review',
  'approval',
];

export interface FlowEfficiency {
  readonly activeMs: number;
  readonly waitMs: number;
  /** active / (active + wait), or null when nothing has been measured. */
  readonly ratio: number | null;
}

/**
 * Flow efficiency: the share of elapsed time that was work.
 *
 * `null` rather than 0 when there is nothing to measure. Zero is a real and
 * alarming answer — everything was queueing — and a card with no history
 * reporting the same number would make an empty dashboard look like a crisis.
 */
export function flowEfficiency(
  visits: readonly StageVisit[],
  waitStages: readonly string[] = DEFAULT_WAIT_STAGES,
): FlowEfficiency {
  let activeMs = 0;
  let waitMs = 0;
  for (const visit of visits) {
    if (visit.ms === null) continue;
    if (waitStages.includes(visit.stage)) waitMs += visit.ms;
    else activeMs += visit.ms;
  }
  const total = activeMs + waitMs;
  return { activeMs, waitMs, ratio: total === 0 ? null : activeMs / total };
}

export interface StageStat {
  readonly stage: string;
  readonly totalMs: number;
  readonly visits: number;
  readonly meanMs: number;
}

/** Per-stage totals across many cards — the value stream map itself. */
export function stageStats(visits: readonly StageVisit[]): readonly StageStat[] {
  const totals = new Map<string, { ms: number; count: number }>();
  for (const visit of visits) {
    if (visit.ms === null) continue;
    const entry = totals.get(visit.stage) ?? { ms: 0, count: 0 };
    totals.set(visit.stage, { ms: entry.ms + visit.ms, count: entry.count + 1 });
  }
  return [...totals.entries()]
    .map(([stage, entry]) => ({
      stage,
      totalMs: entry.ms,
      visits: entry.count,
      meanMs: entry.count === 0 ? 0 : entry.ms / entry.count,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * The binding constraint: the stage work spends most of its time in.
 *
 * Theory of Constraints' one useful claim is that optimising anywhere except
 * the constraint does not move throughput at all. Ranked by *total* time rather
 * than mean, because a stage that is mildly slow for every card costs more than
 * one that is disastrous for a card nobody is waiting on.
 */
export function bottleneck(visits: readonly StageVisit[]): StageStat | null {
  return stageStats(visits)[0] ?? null;
}

export interface ReworkSummary {
  readonly cardsWithRework: number;
  readonly totalRevisits: number;
  /** Stages most often returned to, worst first. */
  readonly hotspots: readonly { readonly stage: string; readonly revisits: number }[];
}

/**
 * Cards that went backwards.
 *
 * Re-entering a stage is the flow signature of a gate catching something late,
 * and it is invisible in cycle time — a card that ping-pongs between implement
 * and review three times and one that walks straight through can take the same
 * nine days.
 */
export function rework(byCard: ReadonlyMap<string, readonly StageVisit[]>): ReworkSummary {
  const hotspots = new Map<string, number>();
  let cardsWithRework = 0;
  let totalRevisits = 0;

  for (const visits of byCard.values()) {
    const seen = new Set<string>();
    let revisited = false;
    for (const visit of visits) {
      if (seen.has(visit.stage)) {
        revisited = true;
        totalRevisits += 1;
        hotspots.set(visit.stage, (hotspots.get(visit.stage) ?? 0) + 1);
      }
      seen.add(visit.stage);
    }
    if (revisited) cardsWithRework += 1;
  }

  return {
    cardsWithRework,
    totalRevisits,
    hotspots: [...hotspots.entries()]
      .map(([stage, revisits]) => ({ stage, revisits }))
      .sort((a, b) => b.revisits - a.revisits),
  };
}

/** Group transition rows by card, ready for the functions above. */
export function visitsByCard(
  transitions: readonly TransitionRow[],
  now: number = Date.now(),
): ReadonlyMap<string, readonly StageVisit[]> {
  const grouped = new Map<string, TransitionRow[]>();
  for (const row of transitions) {
    grouped.set(row.work_item_id, [...(grouped.get(row.work_item_id) ?? []), row]);
  }
  const result = new Map<string, readonly StageVisit[]>();
  for (const [card, rows] of grouped) result.set(card, stageVisits(rows, now));
  return result;
}

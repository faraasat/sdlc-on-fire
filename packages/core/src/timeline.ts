import { stageVisits, type StageVisit, type TransitionRow } from './flow-metrics.js';

/**
 * A work item's lifecycle timeline (P6-SURFACE-04, FEAT-UI-002).
 *
 * "How did we get here" is the question people ask about a card that went
 * wrong, and until now the only answer was `lifecycle_transitions` read by
 * hand. The board shows where a card *is*; nothing showed how it arrived.
 *
 * Built on `stageVisits` rather than beside it. That function already made the
 * decision that matters — a card can **re-enter** a stage, so this is a list of
 * visits and not a map of stages, because a map collapses three trips through
 * `implement` into one and hides exactly the rework that made the card slow.
 * Re-deriving that here would be a second implementation of the one thing the
 * timeline exists to show.
 *
 * What this adds is what a *reader* needs and a metric does not: who moved it,
 * which trip through a stage this is, and where an insertion cut in.
 */

export interface InsertionMarker {
  readonly insertionId: string;
  readonly at: string;
  readonly summary: string;
}

export interface TimelineEntry extends StageVisit {
  /** Who moved it here. Null for a system transition — shown, never hidden. */
  readonly actor: string | null;
  /** Which visit to this stage this is. 1 on the first, 2 on the first rework. */
  readonly visit: number;
  /** True from the second visit onward. */
  readonly reentry: boolean;
  /** Insertions that landed during this visit (FEAT-INS-015). */
  readonly insertions: readonly InsertionMarker[];
}

export interface LifecycleTimeline {
  readonly workItemId: string;
  readonly entries: readonly TimelineEntry[];
  /** Stages entered more than once, in order of first re-entry. */
  readonly reworked: readonly string[];
  /** Total elapsed from the first transition to now-or-last, in ms. */
  readonly elapsedMs: number | null;
  /** Insertions that fall outside every visit — carried, never dropped. */
  readonly unplacedInsertions: readonly InsertionMarker[];
  readonly because: string;
}

/**
 * Builds the timeline.
 *
 * `now` is a parameter and this module reads no clock, so a timeline rendered
 * twice from the same rows is the same timeline.
 */
export function lifecycleTimeline(
  workItemId: string,
  transitions: readonly (TransitionRow & { readonly actor?: string | null })[],
  insertions: readonly InsertionMarker[] = [],
  now: number = Date.now(),
): LifecycleTimeline {
  // No local sort or filter: `stageVisits` does both, and a second copy here
  // would be a second definition of what order a history is in. It was here
  // until actors stopped being attached by array index, which was the only
  // thing that ever needed it.
  const visits = stageVisits(transitions, now);
  const seen = new Map<string, number>();
  const placed = new Set<string>();

  // Actors are attached by **entry time**, not by array index.
  //
  // `stageVisits` sorts its input itself, so aligning `visits[i]` with
  // `ordered[i]` only works while both happen to be in the same order — and a
  // caller that hands over unsorted rows would get every actor attached to the
  // wrong stage, silently. A lookup has no such precondition.
  const actorAt = new Map<number, string | null>(
    transitions.map((row) => [Date.parse(row.created_at), row.actor ?? null]),
  );

  const entries: TimelineEntry[] = visits.map((visit) => {
    const count = (seen.get(visit.stage) ?? 0) + 1;
    seen.set(visit.stage, count);

    const within = insertions.filter((marker) => {
      const at = Date.parse(marker.at);
      if (Number.isNaN(at)) return false;
      // Half-open: an insertion landing exactly at a boundary belongs to the
      // visit it *starts*, not the one it ends. A closed interval would place
      // it in both and double it in the timeline.
      const inside = at >= visit.enteredAt && (visit.leftAt === null || at < visit.leftAt);
      if (inside) placed.add(marker.insertionId);
      return inside;
    });

    return {
      ...visit,
      actor: actorAt.get(visit.enteredAt) ?? null,
      visit: count,
      reentry: count > 1,
      insertions: within,
    };
  });

  const reworked = [...new Set(entries.filter((entry) => entry.reentry).map((e) => e.stage))];
  const first = entries[0];
  const last = entries[entries.length - 1];

  return {
    workItemId,
    entries,
    reworked,
    elapsedMs:
      first === undefined || last === undefined
        ? null
        : Math.max(0, (last.leftAt ?? now) - first.enteredAt),
    // An insertion whose timestamp falls outside every visit is a real record
    // that would otherwise vanish from the one view meant to explain the card.
    // Carried, so somebody can see the clock disagreed rather than see nothing.
    unplacedInsertions: insertions.filter((marker) => !placed.has(marker.insertionId)),
    because:
      entries.length === 0
        ? 'no transitions recorded — this card has not moved, which is not the same as having no history'
        : `${String(entries.length)} transition(s)${reworked.length === 0 ? '' : `, reworked: ${reworked.join(', ')}`}`,
  };
}

function human(ms: number | null): string {
  if (ms === null) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${String(Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${String(Math.round(hours))}h`;
  return `${String(Math.round(hours / 24))}d`;
}

export function formatTimeline(timeline: LifecycleTimeline): string {
  if (timeline.entries.length === 0) {
    return `${timeline.workItemId}: ${timeline.because}`;
  }
  const lines = [`${timeline.workItemId} — ${timeline.because}`, ''];
  for (const entry of timeline.entries) {
    lines.push(
      `  ${entry.stage}${entry.reentry ? ` (visit ${String(entry.visit)})` : ''} · ${human(entry.ms)}${entry.leftAt === null ? ' · still here' : ''}`,
      `      ${entry.actor ?? '(system)'}`,
    );
    for (const marker of entry.insertions) {
      lines.push(`      ↳ ${marker.insertionId}: ${marker.summary}`);
    }
  }
  if (timeline.unplacedInsertions.length > 0) {
    lines.push(
      '',
      `  ${String(timeline.unplacedInsertions.length)} insertion(s) outside every visit — their timestamps disagree with the transitions:`,
      ...timeline.unplacedInsertions.map((marker) => `      ${marker.insertionId} at ${marker.at}`),
    );
  }
  return lines.join('\n');
}

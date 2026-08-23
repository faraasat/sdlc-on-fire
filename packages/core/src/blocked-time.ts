/**
 * Time a work item spent blocked (P6-INSTRUMENT-03, FEAT-MET-002).
 *
 * **This could not be computed before `gates.created_at` existed.** `blocked` is
 * deliberately not a lifecycle state — it is a cross-cutting overlay derived
 * from current gate status (contract 02 §3.2) — so `lifecycle_transitions` has
 * nothing to say about it. And the gates table carried only `evaluated_at` and a
 * watermark `updated_at` that the resolving UPDATE overwrites, so the moment a
 * block *started* was destroyed by the moment it ended.
 *
 * A card is blocked while it has at least one unresolved gate, and the intervals
 * are **merged rather than summed**. Two gates open at once for three hours is
 * three hours of blocked time, not six — the card was waiting the whole time and
 * only once. Summing per gate is the obvious implementation and it reports a
 * number larger than the elapsed life of the card, which is how a metric gets
 * quietly stopped being read.
 */

export interface GateInterval {
  readonly workItemId: string;
  readonly gateName: string;
  /** When the gate was raised. */
  readonly createdAt: string;
  /** When it was resolved, or `null` while it is still open. */
  readonly resolvedAt: string | null;
}

export interface BlockedTime {
  readonly workItemId: string;
  readonly blockedMs: number;
  /** How many distinct blocked stretches, merged. Two at once is one stretch. */
  readonly episodes: number;
  /** True while at least one gate is still open — the total is still growing. */
  readonly stillBlocked: boolean;
}

interface Span {
  start: number;
  end: number;
}

/** Merges overlapping spans. The whole reason blocked time is not a sum. */
export function mergeSpans(spans: readonly Span[]): readonly Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    // Touching counts as overlapping: a gate resolved at 10:00 and another
    // raised at 10:00 is one uninterrupted wait, and reporting two adjacent
    // episodes describes a moment of relief that did not happen.
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

export function blockedTime(gates: readonly GateInterval[], now: string): readonly BlockedTime[] {
  const nowMs = Date.parse(now);
  const byItem = new Map<string, GateInterval[]>();
  for (const gate of gates) {
    const existing = byItem.get(gate.workItemId);
    if (existing === undefined) byItem.set(gate.workItemId, [gate]);
    else existing.push(gate);
  }

  return [...byItem.entries()]
    .map(([workItemId, items]) => {
      const spans: Span[] = [];
      let stillBlocked = false;
      for (const gate of items) {
        const start = Date.parse(gate.createdAt);
        if (Number.isNaN(start)) continue;
        // An open gate is measured to *now*, not skipped. A card blocked for
        // three weeks and never resolved is the one worth seeing, and skipping
        // unresolved gates would report it as never having been blocked at all.
        if (gate.resolvedAt === null) stillBlocked = true;
        const end = gate.resolvedAt === null ? nowMs : Date.parse(gate.resolvedAt);
        if (Number.isNaN(end) || end < start) continue;
        spans.push({ start, end });
      }

      const merged = mergeSpans(spans);
      return {
        workItemId,
        blockedMs: merged.reduce((total, span) => total + (span.end - span.start), 0),
        episodes: merged.length,
        stillBlocked,
      };
    })
    .sort((a, b) => b.blockedMs - a.blockedMs || a.workItemId.localeCompare(b.workItemId));
}

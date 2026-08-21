/**
 * Projecting work items onto a board (P3-KAN-01).
 *
 * Pure, and in core rather than in the UI, for the reason the whole project
 * keeps running into: a board is a *claim* about the state of work, and a claim
 * assembled inside a React render is one nobody can test without a browser.
 * Everything here is a function of its inputs, so the questions that actually
 * matter — is this card blocked, which column does it belong in, what does a
 * capped swimlane do with the overflow — are answered by assertions rather than
 * by screenshots.
 *
 * The column projection itself is {@link kanbanColumnForStage}, which already
 * existed. This adds the grouping, the overlays and the caps around it.
 */

import {
  KANBAN_COLUMNS,
  kanbanColumnForStage,
  LIFECYCLE_STAGES,
  type KanbanColumn,
  type LifecycleStage,
} from './lifecycle.js';

/** A card as the board needs it — the list row plus the two derived summaries. */
export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly lifecycle_state: string;
  readonly risk_level?: string | null;
  readonly parent_id?: string | null;
  readonly claimed_by?: string | null;
  readonly claim_kind?: string | null;
  readonly lease_expires_at?: string | null;
  readonly updated_at?: string;
  /** Worst gate result on the card: any fail wins, else pending, else pass. */
  readonly gate_state?: 'pass' | 'fail' | 'pending' | null;
  /** A run currently executing, if any — drives the live chip. */
  readonly active_run?: string | null;
}

/** The stages at which only a human may act (architecture §5, P3-RBAC-01). */
export const HUMAN_GATED_STAGES: readonly LifecycleStage[] = ['approval', 'review'];

/**
 * Whether a card is blocked.
 *
 * A failing gate is the obvious case. The second is a **stale claim**: a card
 * held by an agent whose lease has expired is not being worked on and is not
 * available to anybody else either, which is the quietest way for work to stop
 * moving — nothing failed, nothing is red, and it simply sits there.
 */
export function isBlocked(card: BoardCard, now: Date = new Date()): boolean {
  if (card.gate_state === 'fail') return true;
  if (card.claimed_by != null && card.lease_expires_at != null) {
    const expires = Date.parse(card.lease_expires_at);
    if (!Number.isNaN(expires) && expires < now.getTime()) return true;
  }
  return false;
}

/** Whether a card is waiting on a person rather than on a machine. */
export function needsHuman(card: BoardCard): boolean {
  return (HUMAN_GATED_STAGES as readonly string[]).includes(card.lifecycle_state);
}

export const GROUP_BY = ['none', 'epic', 'assignee', 'risk'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/**
 * How many swimlanes to show before the rest are collapsed.
 *
 * A cap exists because grouping by assignee on a real backlog produces a lane
 * per person and a board nobody can scan. The overflow is *named and counted*
 * rather than dropped — a board that silently hides work is worse than no
 * grouping at all.
 */
export const SWIMLANE_CAP = 5;
export const OVERFLOW_LANE = '__other__';

export interface BoardFilter {
  readonly text?: string;
  readonly risk?: string | null;
  readonly blockedOnly?: boolean;
  readonly needsHumanOnly?: boolean;
}

export interface Swimlane {
  readonly key: string;
  readonly label: string;
  readonly cards: readonly BoardCard[];
  /** True for the collapsed remainder, so the UI can render it differently. */
  readonly isOverflow: boolean;
}

export interface BoardColumn {
  readonly column: KanbanColumn;
  readonly lanes: readonly Swimlane[];
  readonly total: number;
}

export interface BoardProjection {
  readonly columns: readonly BoardColumn[];
  /** Cards excluded by the filter — shown so a filtered board never looks empty by accident. */
  readonly hidden: number;
  /** Lanes collapsed into the overflow lane, by group key. */
  readonly collapsedLanes: readonly string[];
}

function laneKeyOf(card: BoardCard, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'epic':
      return card.parent_id ?? '(no epic)';
    case 'assignee':
      return card.claimed_by ?? '(unclaimed)';
    case 'risk':
      return card.risk_level ?? '(no risk set)';
    case 'none':
    default:
      return '';
  }
}

function matches(card: BoardCard, filter: BoardFilter, now: Date): boolean {
  const text = (filter.text ?? '').trim().toLowerCase();
  if (text !== '' && !`${card.id} ${card.title}`.toLowerCase().includes(text)) return false;
  if (filter.risk != null && card.risk_level !== filter.risk) return false;
  if (filter.blockedOnly === true && !isBlocked(card, now)) return false;
  if (filter.needsHumanOnly === true && !needsHuman(card)) return false;
  return true;
}

/** A stage string that is not a known stage. Reported, never silently dropped. */
export function isKnownStage(stage: string): stage is LifecycleStage {
  return (LIFECYCLE_STAGES as readonly string[]).includes(stage);
}

export interface ProjectBoardOptions {
  readonly groupBy?: GroupBy;
  readonly filter?: BoardFilter;
  readonly cap?: number;
  readonly now?: Date;
}

/**
 * Group cards into columns and lanes.
 *
 * Every column in {@link KANBAN_COLUMNS} is present in the output even when
 * empty, because a Kanban board's columns are a fixed vocabulary — a column
 * that vanishes when it empties makes the board's shape change under the user
 * and hides where work *should* go next.
 */
export function projectBoard(
  cards: readonly BoardCard[],
  options: ProjectBoardOptions = {},
): BoardProjection {
  const groupBy = options.groupBy ?? 'none';
  const filter = options.filter ?? {};
  const cap = options.cap ?? SWIMLANE_CAP;
  const now = options.now ?? new Date();

  const visible = cards.filter((card) => matches(card, filter, now));
  const hidden = cards.length - visible.length;

  // Lane order is decided once across the whole board, not per column, or the
  // same person's lane would sit in a different row in every column and the
  // grouping would be unreadable.
  const laneSize = new Map<string, number>();
  for (const card of visible) {
    const key = laneKeyOf(card, groupBy);
    laneSize.set(key, (laneSize.get(key) ?? 0) + 1);
  }
  const ordered = [...laneSize.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
  const kept = new Set(groupBy === 'none' ? ordered : ordered.slice(0, cap));
  const collapsedLanes = groupBy === 'none' ? [] : ordered.slice(cap);

  const columns: BoardColumn[] = KANBAN_COLUMNS.map((column) => {
    const inColumn = visible.filter(
      (card) =>
        isKnownStage(card.lifecycle_state) && kanbanColumnForStage(card.lifecycle_state) === column,
    );

    if (groupBy === 'none') {
      return {
        column,
        lanes: [{ key: '', label: '', cards: inColumn, isOverflow: false }],
        total: inColumn.length,
      };
    }

    const lanes: Swimlane[] = [];
    for (const key of ordered.filter((candidate) => kept.has(candidate))) {
      const cardsInLane = inColumn.filter((card) => laneKeyOf(card, groupBy) === key);
      lanes.push({ key, label: key, cards: cardsInLane, isOverflow: false });
    }

    const overflow = inColumn.filter((card) => !kept.has(laneKeyOf(card, groupBy)));
    if (collapsedLanes.length > 0) {
      lanes.push({
        key: OVERFLOW_LANE,
        label: `${String(collapsedLanes.length)} more`,
        cards: overflow,
        isOverflow: true,
      });
    }

    return { column, lanes, total: inColumn.length };
  });

  return { columns, hidden, collapsedLanes };
}

/**
 * A card whose stage this board cannot place.
 *
 * Returned separately rather than dropped. An unknown stage means the database
 * and this build disagree — usually a newer workspace against an older CLI —
 * and a card that silently disappears is the worst way to learn that.
 */
export function unplaceable(cards: readonly BoardCard[]): readonly BoardCard[] {
  return cards.filter((card) => !isKnownStage(card.lifecycle_state));
}

/** A named, shareable board configuration. */
export interface SavedView {
  readonly name: string;
  readonly groupBy: GroupBy;
  readonly filter: BoardFilter;
}

/**
 * Encode a view for a URL.
 *
 * A URL rather than local storage, so a saved view can be pasted to somebody
 * else — "the board I am looking at" is the thing people actually want to
 * share, and a view that only exists in one browser cannot be discussed.
 */
export function encodeView(view: SavedView): string {
  const params = new URLSearchParams();
  params.set('view', view.name);
  if (view.groupBy !== 'none') params.set('group', view.groupBy);
  if (view.filter.text != null && view.filter.text !== '') params.set('q', view.filter.text);
  if (view.filter.risk != null) params.set('risk', view.filter.risk);
  if (view.filter.blockedOnly === true) params.set('blocked', '1');
  if (view.filter.needsHumanOnly === true) params.set('human', '1');
  return params.toString();
}

export function decodeView(query: string): SavedView {
  const params = new URLSearchParams(query);
  const group = params.get('group');
  return {
    name: params.get('view') ?? 'board',
    groupBy: (GROUP_BY as readonly string[]).includes(group ?? '') ? (group as GroupBy) : 'none',
    filter: {
      text: params.get('q') ?? '',
      risk: params.get('risk'),
      blockedOnly: params.get('blocked') === '1',
      needsHumanOnly: params.get('human') === '1',
    },
  };
}

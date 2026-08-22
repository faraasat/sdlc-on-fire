/**
 * The activity feed (P4-COLLAB-01).
 *
 * A board shows *state*; a feed shows *what happened*, and the difference
 * matters most for the things that leave no trace on a card face. A comment
 * that blocked a gate, a run that failed and was retried, a card that went
 * backwards — all of those are invisible in a column position and all of them
 * are the reason somebody opens a board at 9am asking "what changed".
 *
 * **The feed carries the resolved effect, not the comment type.** `role_effect`
 * is computed server-side at insert from (type × role) and never re-derived
 * downstream (ADR-0012). A feed that re-derived it — or that showed the type
 * and let the reader infer — would be a second implementation of the one thing
 * the comment model exists to make unambiguous, and the two would disagree the
 * first time a role's dispatch changed.
 */

import type { RoleEffect } from './comment-effect.js';

export const ACTIVITY_KINDS = ['transition', 'comment', 'gate', 'run', 'claim'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** How loudly an entry should read. Derived, never authored. */
export const ACTIVITY_SEVERITIES = ['blocking', 'attention', 'normal', 'quiet'] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

export interface ActivityEntry {
  readonly kind: ActivityKind;
  readonly at: string;
  readonly cardId: string;
  readonly actor: string | null;
  readonly actorKind: 'human' | 'agent' | null;
  readonly summary: string;
  readonly severity: ActivitySeverity;
  /** Present on comment entries. The computed effect, carried not re-derived. */
  readonly effect?: RoleEffect;
}

/**
 * Effects that stop work, and therefore read as blocking.
 *
 * `GATE_BLOCK` is the one the task calls out. `REQUIRED_CHANGE` and
 * `BUG_CREATION` sit beside it because they have the same practical meaning to
 * whoever is reading the feed: something is now waiting on a person.
 */
export const BLOCKING_EFFECTS: readonly RoleEffect[] = [
  'GATE_BLOCK',
  'REQUIRED_CHANGE',
  'BUG_CREATION',
];

export const ATTENTION_EFFECTS: readonly RoleEffect[] = ['RESCOPE', 'UX_ACCEPTANCE_UPDATE'];

export function severityForEffect(effect: RoleEffect): ActivitySeverity {
  if (BLOCKING_EFFECTS.includes(effect)) return 'blocking';
  if (ATTENTION_EFFECTS.includes(effect)) return 'attention';
  return 'normal';
}

export interface TransitionEvent {
  readonly work_item_id: string;
  readonly from_state: string | null;
  readonly to_state: string;
  readonly created_at: string;
  readonly actor?: string | null;
}

export interface CommentEvent {
  readonly work_item_id: string;
  readonly type: string;
  readonly role_effect: string;
  readonly body: string;
  readonly created_at: string;
  readonly author?: string | null;
  readonly author_kind?: 'human' | 'agent' | null;
}

export interface GateEvent {
  readonly work_item_id: string;
  readonly gate_name: string;
  readonly result: string | null;
  readonly updated_at: string;
}

export interface RunEvent {
  readonly work_item_id: string;
  readonly id: string;
  readonly status: string | null;
  readonly updated_at: string;
  readonly agent_target?: string | null;
}

/** One line of text, short enough to scan. */
function firstLine(body: string, max = 90): string {
  const line = body.split('\n').find((entry) => entry.trim() !== '') ?? '';
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export interface BuildFeedInput {
  readonly transitions?: readonly TransitionEvent[];
  readonly comments?: readonly CommentEvent[];
  readonly gates?: readonly GateEvent[];
  readonly runs?: readonly RunEvent[];
  readonly limit?: number;
}

/**
 * Merge every source into one reverse-chronological feed.
 *
 * Sorted newest first and truncated *after* merging, never before. Truncating
 * each source first would give a feed whose oldest entries are whichever source
 * happened to be quiet — so a busy comment thread would push out every gate
 * result, and the feed would silently stop being a record of what happened.
 */
export function buildFeed(input: BuildFeedInput): readonly ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const row of input.transitions ?? []) {
    entries.push({
      kind: 'transition',
      at: row.created_at,
      cardId: row.work_item_id,
      actor: row.actor ?? null,
      actorKind: null,
      summary:
        row.from_state === null
          ? `entered ${row.to_state}`
          : `moved ${row.from_state} → ${row.to_state}`,
      severity: 'normal',
    });
  }

  for (const row of input.comments ?? []) {
    const effect = row.role_effect as RoleEffect;
    entries.push({
      kind: 'comment',
      at: row.created_at,
      cardId: row.work_item_id,
      actor: row.author ?? null,
      actorKind: row.author_kind ?? null,
      summary: firstLine(row.body),
      severity: severityForEffect(effect),
      effect,
    });
  }

  for (const row of input.gates ?? []) {
    entries.push({
      kind: 'gate',
      at: row.updated_at,
      cardId: row.work_item_id,
      actor: null,
      actorKind: null,
      summary: `gate ${row.gate_name} ${row.result ?? 'pending'}`,
      // A failing gate is blocking; a pending one is not news.
      severity: row.result === 'fail' ? 'blocking' : row.result === 'pass' ? 'normal' : 'quiet',
    });
  }

  for (const row of input.runs ?? []) {
    entries.push({
      kind: 'run',
      at: row.updated_at,
      cardId: row.work_item_id,
      actor: row.agent_target ?? null,
      actorKind: row.agent_target == null ? null : 'agent',
      summary: `run ${row.id} ${row.status ?? 'unknown'}`,
      severity: row.status === 'fail' || row.status === 'error' ? 'attention' : 'quiet',
    });
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const limit = input.limit ?? 200;
  return entries.slice(0, Math.max(0, limit));
}

/** Entries that need a person. Used by the notification tiers (P4-COLLAB-02). */
export function needsAttention(feed: readonly ActivityEntry[]): readonly ActivityEntry[] {
  return feed.filter((entry) => entry.severity === 'blocking' || entry.severity === 'attention');
}

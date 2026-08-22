/**
 * Agents as named teammates (P3-RBAC-09).
 *
 * The product's structural rule is that agents are actors, never approvers. A
 * board that renders an agent exactly like a person quietly undoes that: the
 * rule survives in the database and dies on the screen, because everything a
 * person reads about who did what comes from what they can see.
 *
 * So two things are enforced here rather than left to a designer.
 *
 * **An agent is visibly not a human.** Every rendering of an actor carries its
 * kind, and the function that produces a display label refuses to omit it. A
 * name alone is exactly the ambiguity this exists to remove.
 *
 * **An agent's claim is a proposal, not a fact.** When an agent says a card is
 * done, that is a proposal pending evidence — and it is labelled as one until
 * an evidence envelope backs it. This is the same rule the gate applies, said
 * in the place a person actually looks.
 */

import type { Actor } from './capability.js';

/** How an actor should be shown. Never just a name. */
export interface ActorBadge {
  readonly label: string;
  readonly kind: 'human' | 'agent';
  /** True when the UI must mark this visually, not only in text. */
  readonly nonHuman: boolean;
  readonly title: string;
}

/**
 * The label for an actor, kind included.
 *
 * There is deliberately no variant that returns the bare name. A helper that
 * could omit the kind would be used by the one component that later renders an
 * agent as a person, and that component is the whole problem.
 */
export function actorBadge(actor: Actor): ActorBadge {
  const agent = actor.kind === 'agent';
  return {
    label: agent ? `${actor.displayName} (agent)` : actor.displayName,
    kind: actor.kind,
    nonHuman: agent,
    title: agent
      ? `${actor.displayName} is an agent — it can act, and it cannot approve`
      : actor.displayName,
  };
}

export const CLAIM_STANDINGS = [
  'evidenced',
  'proposal-pending-evidence',
  'human-asserted',
] as const;
export type ClaimStanding = (typeof CLAIM_STANDINGS)[number];

export interface AgentClaim {
  readonly actor: Actor;
  readonly cardId: string;
  readonly assertion: string;
  /** Evidence envelope ids backing this claim. Empty means unbacked. */
  readonly evidenceIds: readonly number[];
}

export interface StandingVerdict {
  readonly standing: ClaimStanding;
  readonly label: string;
  readonly because: string;
}

/**
 * How much weight a claim carries.
 *
 * An agent's unbacked assertion is a *proposal*, and saying so is the entire
 * point: "the tests pass" from an agent with no envelope behind it is precisely
 * the sentence this product exists to refuse, and rendering it identically to a
 * backed one would make the board the place the refusal stops applying.
 *
 * A human's unbacked assertion is labelled differently — `human-asserted` — not
 * because a person is more reliable, but because a person is *accountable*. The
 * distinction is about who can be asked, not about who is right.
 */
export function claimStanding(claim: AgentClaim): StandingVerdict {
  if (claim.evidenceIds.length > 0) {
    return {
      standing: 'evidenced',
      label: 'evidenced',
      because: `${String(claim.evidenceIds.length)} envelope(s) back this`,
    };
  }

  if (claim.actor.kind === 'human') {
    return {
      standing: 'human-asserted',
      label: 'asserted by a person',
      because: `${claim.actor.displayName} asserted this without evidence — a person can be asked why`,
    };
  }

  return {
    standing: 'proposal-pending-evidence',
    label: 'proposal — pending evidence',
    because:
      `${claim.actor.displayName} is an agent and nothing backs this yet. ` +
      'An agent saying so is a proposal, not a result',
  };
}

/* ─────────────────────── actor-scoped memory ─────────────────────── */

export interface MemoryScope {
  /** The actor whose memory this is. Null for project-level memory. */
  readonly actorId: string | null;
  readonly workItemId: string | null;
}

export interface BitemporalRow {
  readonly id: number;
  readonly written_by: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly superseded_by?: number | null;
  readonly conflict_status?: string;
}

/**
 * Whether a memory row was believed at a given instant.
 *
 * Bitemporal because both axes matter and they answer different questions.
 * `valid_from`/`valid_to` say *when the claim was true of the world*; the row is
 * never deleted, only closed. Asking "what did we believe on Tuesday" is how you
 * work out why an agent did something on Tuesday — and a store that deletes
 * superseded rows can answer only "what do we believe now", which is useless
 * for exactly the investigation you open it for.
 */
export function believedAt(row: BitemporalRow, instant: Date): boolean {
  const from = Date.parse(row.valid_from);
  if (Number.isNaN(from) || from > instant.getTime()) return false;
  if (row.valid_to === null) return true;
  const to = Date.parse(row.valid_to);
  return Number.isNaN(to) ? true : to > instant.getTime();
}

/** Rows currently believed, by one actor, at one instant. */
export function memoryFor(
  rows: readonly BitemporalRow[],
  writtenBy: string | null,
  instant: Date = new Date(),
): readonly BitemporalRow[] {
  return rows.filter(
    (row) =>
      believedAt(row, instant) && (writtenBy === null || row.written_by.startsWith(writtenBy)),
  );
}

/**
 * Rows that are contested — two live claims about the same subject.
 *
 * Reported rather than resolved. Picking a winner is a judgement, and the
 * honest move is to surface the disagreement to whoever can settle it; a store
 * that silently prefers the newer claim hides exactly the moment an agent
 * changed its mind about something that mattered.
 */
export function contested(rows: readonly BitemporalRow[]): readonly BitemporalRow[] {
  return rows.filter((row) => row.conflict_status === 'contested' && row.valid_to === null);
}

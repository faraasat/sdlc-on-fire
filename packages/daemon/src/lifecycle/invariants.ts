import type { GuardContext, TransitionGuard } from './engine.js';

/**
 * Lifecycle invariant guards (P1-GATE-03, FEAT-GATE-001).
 *
 * The engine already refuses transitions that are structurally impossible —
 * off-ladder, out of sequence, or out of a terminal stage. These are the layer
 * above: rules that are *possible* to violate and must not be.
 *
 * Each is declared as an explicit `(trigger, predicate, enforcement)` triple
 * rather than an anonymous closure, for one reason: an invariant nobody can
 * enumerate is an invariant nobody can review. `describeInvariants()` renders
 * the whole set, so "what stops X?" has an answer that does not require reading
 * the implementation.
 *
 * `enforcement` is deliberately part of the declaration. A rule that blocks and
 * a rule that warns are different promises, and collapsing them is how a
 * "guard" ends up being advisory without anyone deciding that it should be.
 */

export type Enforcement = 'block' | 'warn';

export interface LifecycleInvariant {
  readonly name: string;
  /** When this invariant is consulted at all. */
  readonly trigger: string;
  /** What must hold, in prose, for a reviewer. */
  readonly predicate: string;
  readonly enforcement: Enforcement;
  /** The decision this implements. */
  readonly reference: string;
  /** Returns `null` to allow, or the reason it refuses. */
  readonly check: TransitionGuard;
}

/** Stages at which real code exists and a claim should therefore be held. */
const EXECUTION_STAGES = new Set(['implement', 'test']);

/**
 * An agent must hold a live claim before it starts executing (ADR-0048).
 *
 * Without this the claim is decorative: two agents can each believe they own a
 * work item, and the second one's diff silently overwrites the first's. The
 * claim table already makes acquisition atomic; this is what makes acquisition
 * *required*.
 */
function claimRequiredToExecute(): TransitionGuard {
  return async ({ workItemId, to, store }: GuardContext): Promise<string | null> => {
    if (!EXECUTION_STAGES.has(to)) return null;

    const rows = await store.query<{ claimed_by: string | null }>(
      `SELECT claimed_by FROM work_items
        WHERE id = $1 AND claimed_by IS NOT NULL AND lease_expires_at > now();`,
      [workItemId],
    );
    return rows.length > 0
      ? null
      : `${workItemId} has no live claim; acquire one before entering "${to}" (ADR-0048)`;
  };
}

/**
 * A spec must exist before implementation begins.
 *
 * The failure this prevents is the expensive one: an agent implements its own
 * interpretation, review discovers the interpretation was wrong, and the work
 * is thrown away. Cheap to check, and it is checked against a stored artifact
 * rather than the agent's assertion that it "understands the requirements".
 */
function specBeforeImplement(): TransitionGuard {
  return async ({
    workItemId,
    to,
    preset,
    workType,
    store,
  }: GuardContext): Promise<string | null> => {
    if (to !== 'implement') return null;
    // Only meaningful where the ladder actually has a spec stage — an atomic
    // task under `lite` never had one to skip.
    const { resolveRequiredStages } = await import('@sdlc-on-fire/core');
    if (!resolveRequiredStages(preset, workType)?.includes('spec')) return null;

    const rows = await store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lifecycle_transitions
        WHERE work_item_id = $1 AND to_state = 'spec';`,
      [workItemId],
    );
    return (rows[0]?.n ?? 0) > 0
      ? null
      : `${workItemId} never passed through "spec"; implementing an unspecified item is how work gets thrown away`;
  };
}

/**
 * Reaching `done` requires the item to have been reviewed.
 *
 * The ladder already orders review before done, but a ladder is a *route*, not
 * a receipt: an item whose stage was written directly into the mirror could
 * arrive at review's doorstep without a transition record. This checks the
 * record.
 */
function reviewBeforeDone(): TransitionGuard {
  return async ({
    workItemId,
    to,
    preset,
    workType,
    store,
  }: GuardContext): Promise<string | null> => {
    if (to !== 'done') return null;
    const { resolveRequiredStages } = await import('@sdlc-on-fire/core');
    if (!resolveRequiredStages(preset, workType)?.includes('review')) return null;

    const rows = await store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lifecycle_transitions
        WHERE work_item_id = $1 AND to_state = 'review';`,
      [workItemId],
    );
    return (rows[0]?.n ?? 0) > 0
      ? null
      : `${workItemId} has no recorded review transition; "done" without review is the claim this product exists to refuse`;
  };
}

/**
 * A `strict` item cannot reach `done` without a human approval on record.
 *
 * Agents are actors, never approvers (architecture §5). The DB trigger already
 * refuses an agent's role-gated approval; this refuses the *absence* of a human
 * one, which the trigger cannot see.
 */
function humanApprovalForStrict(): TransitionGuard {
  return async ({ workItemId, to, preset, store }: GuardContext): Promise<string | null> => {
    if (to !== 'done' || preset !== 'strict') return null;

    const rows = await store.query<{ n: number }>(
      // Approvals hang off a gate, not off the work item directly, so the join
      // goes through `gates`. A revoked approval does not count: withdrawing
      // consent has to actually withdraw it.
      `SELECT count(*)::int AS n
         FROM approvals a
         JOIN gates g ON g.id = a.gate_id
         JOIN actors ac ON ac.id = a.actor_id
        WHERE g.work_item_id = $1
          AND a.decision = 'approve'
          AND a.revoked_at IS NULL
          AND ac.kind = 'human';`,
      [workItemId],
    );
    return (rows[0]?.n ?? 0) > 0
      ? null
      : `${workItemId} is a strict-preset item with no human approval recorded`;
  };
}

export const LIFECYCLE_INVARIANTS: readonly LifecycleInvariant[] = [
  {
    name: 'claim-required-to-execute',
    trigger: 'transition into implement or test',
    predicate: 'the work item has a live, unexpired claim',
    enforcement: 'block',
    reference: 'ADR-0048',
    check: claimRequiredToExecute(),
  },
  {
    name: 'spec-before-implement',
    trigger: 'transition into implement, on a ladder that has a spec stage',
    predicate: 'a transition into spec was previously recorded',
    enforcement: 'block',
    reference: 'ADR-0008',
    check: specBeforeImplement(),
  },
  {
    name: 'review-before-done',
    trigger: 'transition into done, on a ladder that has a review stage',
    predicate: 'a transition into review was previously recorded',
    enforcement: 'block',
    reference: 'architecture §5',
    check: reviewBeforeDone(),
  },
  {
    name: 'human-approval-for-strict',
    trigger: 'transition into done on a strict-preset item',
    predicate: 'at least one approve decision by a human actor exists',
    enforcement: 'block',
    reference: 'ADR-0008 / architecture §5',
    check: humanApprovalForStrict(),
  },
];

/** Registers every invariant on an engine. */
export function registerLifecycleInvariants(engine: {
  registerGuard(name: string, guard: TransitionGuard): void;
}): void {
  for (const invariant of LIFECYCLE_INVARIANTS) {
    engine.registerGuard(invariant.name, invariant.check);
  }
}

/** The reviewable rendering — what stops what, and on whose authority. */
export function describeInvariants(): readonly Omit<LifecycleInvariant, 'check'>[] {
  return LIFECYCLE_INVARIANTS.map(({ check: _check, ...rest }) => rest);
}

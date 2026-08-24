import type { BlastRadius } from './blast-radius.js';

/**
 * Selective re-wave and open-PR-safe insertion (P6-INFLIGHT-01, P6-INFLIGHT-02;
 * FEAT-INS-007, FEAT-INS-011).
 *
 * `blast-radius.ts` has said this in a comment since P2-INS-01 — "re-plan the
 * affected subgraph" is the honest middle answer between re-planning everything
 * and appending and hoping. It computed the subgraph and nothing ever decided
 * what to *do* with it.
 *
 * **The rule that matters is which items are left alone.** An item somebody is
 * halfway through implementing is inside almost every blast radius, and
 * re-planning it discards work in progress to fix a plan — which is the trade
 * nobody would make deliberately and everybody makes by accident when the
 * re-wave is "everything the walk reached".
 *
 * There is no wave *executor* here. Deciding the scope and running it are
 * different jobs, and the second belongs to the wave planner (P2-AGENT-02).
 * Building the decision against an executor that does not exist yet is how the
 * decision ends up shaped by the executor's convenience.
 */

/** Enough of a work item to decide whether it may be disturbed. */
export interface InFlightItem {
  readonly id: string;
  readonly lifecycleState: string;
  /** Who holds it, or null. A claimed item has somebody's attention on it. */
  readonly claimedBy?: string | null | undefined;
  /** Set once a pull request has been opened for it. */
  readonly prUrl?: string | null | undefined;
}

/**
 * Stages at which re-planning destroys work rather than redirecting it.
 *
 * `implement` and `review` only. Everything earlier is a plan, and re-planning a
 * plan is the point; everything later is finished. A card at `spec` being
 * re-waved loses a draft; a card at `implement` being re-waved loses a branch.
 */
export const UNDISTURBABLE_STAGES = ['implement', 'review'] as const;

export interface ReWaveScope {
  /** Items in the radius that should be re-planned. */
  readonly rePlan: readonly string[];
  /** Items deliberately left alone, each with the reason. */
  readonly leftAlone: readonly { readonly id: string; readonly because: string }[];
  /**
   * Items the walk could not reach, carried through verbatim.
   *
   * Not re-derived and not dropped. The bound is two hops and a radius that
   * stops without saying it stopped reads exactly like one that found
   * everything — that warning has to survive into the scope decision or it only
   * ever warned the person who ran the scan.
   */
  readonly unexplored: readonly string[];
}

export function reWaveScope(radius: BlastRadius, items: readonly InFlightItem[]): ReWaveScope {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rePlan: string[] = [];
  const leftAlone: { id: string; because: string }[] = [];

  for (const reached of radius.reached) {
    const item = byId.get(reached.id);
    if (item === undefined) {
      // Unknown to the board. Re-planned rather than skipped: an id in the
      // radius that nothing can describe is exactly the item worth a second
      // look, and silently dropping it is how the radius shrinks to what was
      // convenient.
      rePlan.push(reached.id);
      continue;
    }

    if ((UNDISTURBABLE_STAGES as readonly string[]).includes(item.lifecycleState)) {
      leftAlone.push({
        id: item.id,
        because: `mid-${item.lifecycleState} — re-planning it would discard work in progress`,
      });
      continue;
    }

    // A claim is somebody's attention, even at an early stage. Left alone with a
    // different reason, because the fix is different: the first needs the plan
    // to wait, this one needs a conversation.
    if (item.claimedBy !== null && item.claimedBy !== undefined && item.claimedBy !== '') {
      leftAlone.push({ id: item.id, because: `claimed by ${item.claimedBy}` });
      continue;
    }

    rePlan.push(item.id);
  }

  return {
    rePlan,
    leftAlone,
    unexplored: radius.unexplored,
  };
}

/* -------------------------------------------------------------------------- */

export type InsertionShape = 'mutate' | 'follow-up';

export interface InsertionShapeDecision {
  readonly shape: InsertionShape;
  readonly because: string;
}

/**
 * Whether an insertion may change the target, or must become a follow-up
 * (P6-INFLIGHT-02, FEAT-INS-011).
 *
 * **A target with a pull request open becomes a follow-up.** Changing the scope
 * of work that has already been proposed for merge invalidates a review that
 * already happened — the reviewer approved a diff, and the diff is now going to
 * be a different diff without the approval being withdrawn.
 *
 * The feature says "near-merged", and near-merged is not something this
 * workspace can see: merge state lives on the forge, and the product records
 * that a PR was *opened* and nothing else (the same limit `metrics governance`
 * reports for PR duration). So the rule is the conservative reading of what is
 * actually observable — any open PR, not a guess at how close it is. A follow-up
 * when a mutation would have been fine costs one extra card; a mutation when a
 * follow-up was needed costs a review nobody redid.
 */
export function insertionShapeFor(target: InFlightItem | undefined): InsertionShapeDecision {
  if (target === undefined) {
    return { shape: 'mutate', because: 'the target is not on the board yet' };
  }
  if (target.prUrl !== null && target.prUrl !== undefined && target.prUrl !== '') {
    return {
      shape: 'follow-up',
      because: `${target.id} already has a pull request open — changing its scope now invalidates a review that already happened`,
    };
  }
  return { shape: 'mutate', because: `${target.id} has no pull request open` };
}

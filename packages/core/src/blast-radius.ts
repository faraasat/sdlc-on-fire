/**
 * Blast-radius analysis for hard insertion (P2-INS-01, `.research/11 §3`).
 *
 * Landing new work into a live epic mid-flight has two honest answers and one
 * dishonest one. The honest answers are "re-plan everything" (correct, and so
 * expensive nobody does it) and "re-plan the affected subgraph" (what this
 * computes). The dishonest one is appending the item and letting whatever
 * breaks break — which is what happens by default in every tool that lacks
 * this step, because nothing in the moment of insertion asks the question.
 *
 * **The bound is two hops, and the bound is the interesting part.**
 * `.research/11 §5` names the risk in its own words: an insertion whose true
 * impact is three or more hops away silently escapes the re-wave scope. A
 * radius that stops at two hops and does not say it stopped reads exactly like
 * a radius that found everything — the same failure shape as an unreachable
 * advisory source returning "no advisories". So the walk reports what it did
 * not explore, by ID and by count, and that report travels into the insertion
 * record in front of the person approving the rescope.
 *
 * The high-risk-surface override is deliberately *not* re-implemented here:
 * `regressionScopeFor` already owns "does this force full regression", and a
 * second copy of that rule is one more chance for the two to disagree.
 */

import { regressionScopeFor, type RegressionDecision } from './regression-scope.js';
import type { ChangedFile } from './risk-surface.js';

/**
 * How far the walk goes.
 *
 * Two, from `.research/11`, and chosen for a reason worth keeping: the walk has
 * to be cheap enough to run on *every* insertion rather than only during a
 * planning ceremony, because a dependency check nobody runs is a dependency
 * check that does not exist. An unbounded walk on a mature backlog reaches
 * everything, and a radius containing every item tells you nothing at all.
 */
export const MAX_HOPS = 2;

export interface WorkItemNode {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly relatesTo?: readonly string[] | undefined;
  readonly blocks?: readonly string[] | undefined;
  readonly blockedBy?: readonly string[] | undefined;
  /**
   * Files this item has declared it owns (ADR-0041 file-ownership declaration).
   */
  readonly ownedPaths?: readonly string[] | undefined;
  /**
   * Whether work is actually underway on this item right now.
   *
   * Required rather than derived, and required rather than optional: the
   * caller — which has the claim table (ADR-0048) — knows this, and a default
   * of `false` would mean a caller that forgot to populate it gets a clean
   * report instead of a wrong one.
   */
  readonly inFlight: boolean;
}

export interface ReachedItem {
  readonly id: string;
  readonly hop: number;
}

export interface OwnershipFinding {
  /**
   * `conflict` — the same file, written by two items at once. A collision.
   * `overlap` — in-flight work inside the blast radius that shares no file.
   *
   * `.research/11 §5` flags exactly this as needing separation: the
   * file-ownership check was built for concurrent-agent write conflicts, and
   * "does this insertion's blast radius overlap in-flight work" is not the same
   * question. Overlap without a shared file is still a planning risk — the
   * story someone is halfway through may be the story this insertion
   * invalidates — and reporting only collisions would answer the easy question
   * and quietly drop the hard one.
   */
  readonly severity: 'conflict' | 'overlap';
  readonly itemId: string;
  readonly paths: readonly string[];
  readonly message: string;
}

export interface BlastRadius {
  readonly target: string;
  /** Everything within {@link MAX_HOPS}, nearest first. */
  readonly reached: readonly ReachedItem[];
  /** True when edges existed past the bound and were not followed. */
  readonly truncated: boolean;
  /** The items one hop past the bound — named, not just counted. */
  readonly unexplored: readonly string[];
  readonly ownership: readonly OwnershipFinding[];
  readonly regression: RegressionDecision;
}

export interface BlastRadiusRequest {
  /** The container the item is being inserted into. */
  readonly into: string;
  readonly workType: string;
  /** Files the inserted item expects to own, if known at insertion time. */
  readonly ownedPaths?: readonly string[] | undefined;
  /** Changed files, when the insertion arrives with a diff already in hand. */
  readonly changed?: readonly ChangedFile[] | undefined;
}

/**
 * Neighbours of a node, in both directions.
 *
 * Traversing the declared edges alone finds nothing useful, and the reason is
 * structural rather than incidental: `parent_id` points from a child *up* to
 * its container, and an insertion targets the container. A forward-only walk
 * from `EPIC-001` therefore reaches none of the stories inside it — the exact
 * set the insertion displaces. So edges are followed in both directions, and
 * the reverse index is built once per walk rather than per node.
 */
function neighbourIndex(nodes: readonly WorkItemNode[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    for (const [a, b] of [
      [from, to],
      [to, from],
    ] as const) {
      let set = index.get(a);
      if (set === undefined) {
        set = new Set<string>();
        index.set(a, set);
      }
      set.add(b);
    }
  };

  for (const node of nodes) {
    if (node.parentId !== undefined && node.parentId !== '') link(node.id, node.parentId);
    for (const other of node.relatesTo ?? []) link(node.id, other);
    for (const other of node.blocks ?? []) link(node.id, other);
    for (const other of node.blockedBy ?? []) link(node.id, other);
  }
  return index;
}

/**
 * What an insertion into `request.into` touches, bounded at {@link MAX_HOPS}.
 */
export function computeBlastRadius(
  request: BlastRadiusRequest,
  nodes: readonly WorkItemNode[],
): BlastRadius {
  const index = neighbourIndex(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const reached: ReachedItem[] = [];
  const seen = new Set<string>([request.into]);
  const unexplored = new Set<string>();

  let frontier: readonly string[] = [request.into];
  for (let hop = 1; hop <= MAX_HOPS; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of index.get(id) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        reached.push({ id: neighbour, hop });
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  // One more level, walked only to be *counted*. Reporting "the walk stopped
  // here" without saying whether anything was behind the stop leaves the reader
  // unable to tell a complete radius from a clipped one, which is the whole
  // failure this is guarding against.
  for (const id of frontier) {
    for (const neighbour of index.get(id) ?? []) {
      if (!seen.has(neighbour)) unexplored.add(neighbour);
    }
  }

  const ownedPaths = new Set(request.ownedPaths ?? []);
  const ownership: OwnershipFinding[] = [];
  for (const { id } of reached) {
    const node = byId.get(id);
    if (node === undefined || !node.inFlight) continue;

    const shared = (node.ownedPaths ?? []).filter((p) => ownedPaths.has(p));
    ownership.push(
      shared.length > 0
        ? {
            severity: 'conflict',
            itemId: id,
            paths: shared,
            message: `${id} is in flight and already owns ${shared.join(', ')} — two items writing one file`,
          }
        : {
            severity: 'overlap',
            itemId: id,
            paths: [],
            message: `${id} is in flight inside this insertion's blast radius — no file collision, but its scope may no longer hold`,
          },
    );
  }

  return {
    target: request.into,
    reached,
    truncated: unexplored.size > 0,
    unexplored: [...unexplored].sort(),
    ownership,
    regression: regressionScopeFor(request.workType, request.changed ?? []),
  };
}

export function formatBlastRadius(radius: BlastRadius): string {
  const lines = [`Blast radius of an insertion into ${radius.target}:`];

  if (radius.reached.length === 0) {
    lines.push(`  nothing within ${String(MAX_HOPS)} hops`);
  } else {
    for (const item of radius.reached) {
      lines.push(`  ${item.id} (${String(item.hop)} hop${item.hop === 1 ? '' : 's'})`);
    }
  }

  if (radius.truncated) {
    lines.push(
      '',
      `  ⚠ the walk stopped at ${String(MAX_HOPS)} hops with ${String(radius.unexplored.length)} item(s) beyond it:`,
      `    ${radius.unexplored.join(', ')}`,
      '    These were not analysed. This radius is a lower bound, not a complete one.',
    );
  }

  if (radius.ownership.length > 0) {
    lines.push('');
    for (const finding of radius.ownership) {
      lines.push(`  [${finding.severity}] ${finding.message}`);
    }
  }

  lines.push('', `  regression: ${radius.regression.scope} — ${radius.regression.reason}`);
  return lines.join('\n');
}

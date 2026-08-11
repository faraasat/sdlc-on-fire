/**
 * How much of the suite a change has to re-run (P2-LIFE-02, FEAT-LIFE-002).
 *
 * Selective gate re-open is the default and it is a good default: only gates
 * whose covered files were actually touched flip back, so a one-line change
 * does not re-run an hour of tests. `.research/11` specifies it, and it works
 * because "what could this change have broken?" is usually answerable from the
 * files it touched.
 *
 * **Usually.** The exception is the reason `migrate` exists as a work type
 * separate from `refactor`, and the distinction is not bookkeeping:
 *
 * - A **refactor** changes code and preserves behaviour and data. Its blast
 *   radius really is the files it touched, so selective re-run is honest, and a
 *   mistake is undone with `git revert`.
 * - A **migration** changes the data, the schema, or the platform underneath
 *   code nobody edited. The files it touched say nothing about what it can
 *   break — a column rename breaks every query in the system, and not one of
 *   those files appears in the diff. `git revert` does not put the data back.
 *
 * So `migrate` forces **full regression regardless of what the diff touched**,
 * which is the same rule `.research/11` already applies to auth, payments and
 * migrations at the insertion engine. This states it once, as a property of the
 * work type, rather than leaving each caller to remember.
 */

import { detectRiskSurfaces, type ChangedFile } from './risk-surface.js';

export type RegressionScope = 'selective' | 'full';

export interface RegressionDecision {
  readonly scope: RegressionScope;
  readonly reason: string;
}

/**
 * Work types whose blast radius is not expressible as "the files it touched".
 *
 * A set rather than a flag on each row, because the question "does this force
 * full regression" gets asked from the gate, the insertion engine, and the CLI,
 * and three copies of the answer is two chances to disagree.
 */
const ALWAYS_FULL = new Set(['migrate']);

/**
 * Surfaces where a change reaches further than its diff.
 *
 * From `.research/11`: high-risk areas force full regression regardless of
 * selective re-open. `migrations` is here as well as in `ALWAYS_FULL` on
 * purpose — a schema change inside a `feature` work item is still a schema
 * change, and keying only on work type would let it through by relabelling.
 */
const ALWAYS_FULL_SURFACES = new Set(['auth', 'payments', 'migrations']);

export function regressionScopeFor(
  workType: string,
  changed: readonly ChangedFile[] = [],
): RegressionDecision {
  if (ALWAYS_FULL.has(workType)) {
    return {
      scope: 'full',
      reason: `${workType} changes data or platform underneath code nobody edited — the diff does not bound the blast radius`,
    };
  }

  const surfaces = [
    ...new Set(
      detectRiskSurfaces(changed)
        .map((finding) => finding.surface)
        .filter((surface) => ALWAYS_FULL_SURFACES.has(surface)),
    ),
  ];

  if (surfaces.length > 0) {
    return {
      scope: 'full',
      reason: `touches ${surfaces.join(', ')} — high-risk surfaces force full regression regardless of work type`,
    };
  }

  return {
    scope: 'selective',
    reason: 'blast radius is bounded by the files this change touched',
  };
}

/**
 * Whether a selective re-run may be trusted for this change.
 *
 * The inverse is deliberately not "is it safe" — a full regression is not proof
 * of safety either. It is the difference between a suite that had a chance to
 * catch the failure and one that structurally could not.
 */
export function mayRunSelective(workType: string, changed: readonly ChangedFile[] = []): boolean {
  return regressionScopeFor(workType, changed).scope === 'selective';
}

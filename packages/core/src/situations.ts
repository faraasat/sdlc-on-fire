import { detectRiskSurfaces, type ChangedFile } from './risk-surface.js';
import { type SkillSituation } from './skill.js';
import { detectUiSurface } from './ui-surface.js';

/**
 * The situations a diff puts a change in (P6-PAYLOAD-05).
 *
 * `skillForSituation` existed with **no production caller**. Five situational
 * skills — `resolve-conflict`, `architecture`, `implementation-planning`,
 * `write-tests`, `security-review` — were written, registered and compiled to
 * six targets, and nothing ever asked which of them applied. Sixth instance this
 * phase of a read path with no writer, and the same symptom every time: not an
 * error, silence.
 *
 * This closes half of it. A diff can answer two of the five questions, and the
 * name says so rather than implying it answers all of them — `situationsFor`
 * would have been a function that quietly under-reports, which is worse than one
 * that visibly covers less.
 */
/**
 * The situations this function can produce, as data.
 *
 * Declared once rather than restated inside `unaccountedSituations`. The
 * alternative is two copies of one list agreeing until they do not, which is the
 * shape this repository has now found five times.
 */
export const SITUATIONS_FROM_DIFF = ['high-risk-surface', 'touches-ui'] as const;

export function situationsFromDiff(changed: readonly ChangedFile[]): readonly SkillSituation[] {
  const situations: SkillSituation[] = [];
  if (detectRiskSurfaces(changed).length > 0) situations.push('high-risk-surface');
  if (detectUiSurface(changed.map((file) => file.path)).length > 0) situations.push('touches-ui');
  return situations;
}

/**
 * Situations a diff cannot see, and what does see them.
 *
 * A census, so the coverage check can be total. Without it the test would assert
 * that the situations this function *does* produce are valid — which is true of
 * a function that produces none.
 */
export const SITUATIONS_NOT_FROM_DIFF: Readonly<Record<string, string>> = {
  // A conflict is a git state, not a property of the resulting diff.
  'merge-conflict': 'git, during a merge or rebase',
  // Both are properties of the plan, and are known before any file changes.
  'crosses-module-boundary': 'the decomposition, via blast radius',
  'oversized-story': 'the decomposition, by story size',
  // A gate result, not a property of the diff: the diff can show that no
  // integration test was added and still not know that one was required.
  'tier-unsatisfied': 'the gate, when a required test tier has no files',
};

/*
 * There was a `unaccountedSituations()` here, computing the same set-difference
 * the coverage test asserts. Mutation testing killed it: replacing its body with
 * `return []` broke nothing, because the test that used it was checking the
 * censuses directly and the function was a second, weaker way of asking. A guard
 * whose only caller is the assertion that duplicates it is not a guard.
 */

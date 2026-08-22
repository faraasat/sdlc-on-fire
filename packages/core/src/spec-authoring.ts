/**
 * Native brownfield authoring (P4-BROWN-01).
 *
 * The delta model this repo already reads from OpenSpec, written by us instead
 * of parsed from somebody else: `specs/<domain>/spec.md` holds the current
 * truth, `changes/<id>/` holds a proposed delta against it, and
 * `changes/archive/` holds the deltas that have landed.
 *
 * **Why a delta model at all.** On a brownfield project the specification
 * already exists — in the code, in people's heads, in four documents that
 * disagree. Rewriting the whole spec for every change produces a document
 * nobody reviews, because a 400-line diff where 12 lines matter is not a review
 * surface. A delta names exactly what it adds, modifies, removes or renames,
 * and can therefore be read in full by the person approving it.
 *
 * **Two validations do the real work, and both are refusals rather than
 * warnings** (ADR-0040 — the deterministic disposer is a grammar, not a model):
 *
 *   * *A requirement without an RFC-2119 keyword is a sentence.* "The system
 *     handles retries" cannot be satisfied or violated; "The system MUST retry
 *     at most three times" can. Without the keyword there is nothing for a gate
 *     to check and nothing for a reviewer to disagree with.
 *   * *A scenario without a THEN cannot fail.* GIVEN and WHEN set up a world;
 *     THEN is the only part that makes a claim. A scenario missing it reads as
 *     a test and passes unconditionally, which is worse than having no test —
 *     the same defect this product exists to refuse from an agent.
 */

import type { DELTA_KINDS } from './docs.js';

/** One of `docs.ts`'s delta kinds. Named here for readability at the use sites. */
export type DeltaKind = (typeof DELTA_KINDS)[number];

/** RFC 2119 §1–§5, plus the RFC 8174 lowercase caveat: only uppercase is normative. */
export const RFC2119_KEYWORDS = [
  'MUST',
  'MUST NOT',
  'REQUIRED',
  'SHALL',
  'SHALL NOT',
  'SHOULD',
  'SHOULD NOT',
  'RECOMMENDED',
  'MAY',
  'OPTIONAL',
] as const;
export type Rfc2119Keyword = (typeof RFC2119_KEYWORDS)[number];

/**
 * The delta vocabulary is `docs.ts`'s, imported rather than restated.
 *
 * It already carries the fixed application order — renames first so later
 * deltas address the new name, removals before modifications so a modify never
 * targets something about to vanish, additions last so they cannot be
 * clobbered. A second copy here would be a second answer to "what is a delta",
 * and the two would drift the first time that order was revised.
 */

export interface Scenario {
  readonly given: readonly string[];
  readonly when: readonly string[];
  readonly then: readonly string[];
}

export interface AuthoredRequirement {
  readonly title: string;
  readonly body: string;
  /** Every RFC-2119 keyword used, in order of appearance. */
  readonly keywords: readonly Rfc2119Keyword[];
  readonly scenarios: readonly Scenario[];
  readonly delta?: DeltaKind | undefined;
}

export interface SpecProblem {
  readonly requirement: string;
  readonly because: string;
  /** `refusal` blocks; `advice` is reported and does not. */
  readonly severity: 'refusal' | 'advice';
}

/**
 * Find the normative keywords in a requirement body.
 *
 * **Uppercase only.** RFC 8174 is explicit that the keywords are normative only
 * when capitalised, and the distinction is load-bearing here rather than
 * pedantic: "the system should be fast" is a wish and "the system SHOULD retry"
 * is a requirement, and a matcher that ignored case would silently promote every
 * casual sentence in the document into a testable obligation.
 *
 * Longest-first, so `MUST NOT` is never reported as `MUST` — which would invert
 * the requirement's meaning in the one place that matters most.
 */
export function findKeywords(body: string): readonly Rfc2119Keyword[] {
  const found: { index: number; keyword: Rfc2119Keyword }[] = [];
  const claimed: [number, number][] = [];

  const byLength = [...RFC2119_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const keyword of byLength) {
    const pattern = new RegExp(`\\b${keyword.replace(' ', '\\s+')}\\b`, 'g');
    for (const match of body.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      // Skip a span already taken by a longer keyword: `MUST NOT` owns its
      // `MUST`, and reporting both would make the requirement read as
      // self-contradictory.
      if (claimed.some(([from, to]) => start >= from && start < to)) continue;
      claimed.push([start, end]);
      found.push({ index: start, keyword });
    }
  }

  return found.sort((a, b) => a.index - b.index).map((entry) => entry.keyword);
}

const GIVEN = /^\s*(?:-\s*)?GIVEN\s+(.+?)\s*$/i;
const WHEN = /^\s*(?:-\s*)?WHEN\s+(.+?)\s*$/i;
const THEN = /^\s*(?:-\s*)?(?:THEN|AND)\s+(.+?)\s*$/i;

/**
 * Parse GIVEN/WHEN/THEN blocks out of a requirement body.
 *
 * A new `GIVEN` starts a new scenario. `AND` continues whichever clause was
 * last opened, which is how people actually write these — and treating a
 * trailing `AND` as a fresh clause would split one scenario into two, each
 * missing half its setup.
 */
export function parseScenarios(body: string): readonly Scenario[] {
  const scenarios: Scenario[] = [];
  let current: { given: string[]; when: string[]; then: string[] } | null = null;
  let clause: 'given' | 'when' | 'then' | null = null;

  const flush = (): void => {
    if (current !== null) scenarios.push(current);
    current = null;
    clause = null;
  };

  for (const line of body.split('\n')) {
    const given = GIVEN.exec(line);
    if (given !== null) {
      flush();
      current = { given: [given[1] ?? ''], when: [], then: [] };
      clause = 'given';
      continue;
    }
    if (current === null) continue;

    const when = WHEN.exec(line);
    if (when !== null) {
      current.when.push(when[1] ?? '');
      clause = 'when';
      continue;
    }
    const then = THEN.exec(line);
    if (then !== null) {
      // `AND` continues the open clause; `THEN` opens the assertion clause.
      const isThen = /^\s*(?:-\s*)?THEN\b/i.test(line);
      const target = isThen ? 'then' : (clause ?? 'then');
      current[target].push(then[1] ?? '');
      if (isThen) clause = 'then';
      continue;
    }
    if (line.trim() === '') flush();
  }
  flush();
  return scenarios;
}

/**
 * Validate one authored requirement.
 *
 * Refusals only for the two failures that make a document lie: a requirement
 * that cannot be violated, and a scenario that cannot fail. Everything else is
 * advice, because a spec is prose somebody has to live with and a validator
 * that argues about style is one they turn off.
 */
export function validateRequirement(requirement: AuthoredRequirement): readonly SpecProblem[] {
  const problems: SpecProblem[] = [];

  if (requirement.keywords.length === 0) {
    problems.push({
      requirement: requirement.title,
      because:
        'no RFC-2119 keyword — a requirement that cannot be violated is a sentence, not a requirement',
      severity: 'refusal',
    });
  }

  requirement.scenarios.forEach((scenario, index) => {
    if (scenario.then.length === 0) {
      problems.push({
        requirement: requirement.title,
        because: `scenario ${String(index + 1)} has no THEN — it sets up a world and asserts nothing, so it cannot fail`,
        severity: 'refusal',
      });
    }
    if (scenario.when.length === 0) {
      problems.push({
        requirement: requirement.title,
        because: `scenario ${String(index + 1)} has no WHEN — nothing happens, so the THEN is about the setup`,
        severity: 'advice',
      });
    }
  });

  if (requirement.scenarios.length === 0) {
    problems.push({
      requirement: requirement.title,
      because: 'no GIVEN/WHEN/THEN scenario — nothing here says how to tell whether it holds',
      severity: 'advice',
    });
  }

  // A REMOVED delta is the one kind that legitimately carries no keyword and no
  // scenario: it deletes a requirement rather than stating one. Withdraw the
  // refusals rather than special-casing them above, so the rule stays readable.
  if (requirement.delta === 'REMOVED') {
    return problems.filter((problem) => problem.severity !== 'refusal');
  }

  return problems;
}

export function validateSpec(requirements: readonly AuthoredRequirement[]): readonly SpecProblem[] {
  const problems = requirements.flatMap((requirement) => validateRequirement(requirement));

  // Duplicate titles within one document. Requirements are referenced by title
  // in changes and in review, so two with the same name make every reference
  // ambiguous — and the ambiguity is invisible until somebody resolves it the
  // wrong way.
  const seen = new Map<string, number>();
  for (const requirement of requirements) {
    seen.set(requirement.title, (seen.get(requirement.title) ?? 0) + 1);
  }
  for (const [title, count] of seen) {
    if (count > 1) {
      problems.push({
        requirement: title,
        because: `appears ${String(count)} times — a change referencing it by title cannot say which`,
        severity: 'refusal',
      });
    }
  }

  return problems;
}

/** Whether a set of problems blocks. Advice never does. */
export function blocks(problems: readonly SpecProblem[]): boolean {
  return problems.some((problem) => problem.severity === 'refusal');
}

/** Where a domain's current spec lives. */
export function specPath(domain: string): string {
  return `specs/${domain}/spec.md`;
}

/** Where a proposed change lives before it lands. */
export function changePath(changeId: string): string {
  return `changes/${changeId}/proposal.md`;
}

/**
 * Where a change goes after it lands.
 *
 * Archived rather than deleted. The delta is the record of *why* the spec says
 * what it says, and a project that deletes its landed changes keeps the
 * conclusion and throws away the argument.
 */
export function archivePath(changeId: string): string {
  return `changes/archive/${changeId}/proposal.md`;
}

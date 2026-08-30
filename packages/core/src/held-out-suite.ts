/**
 * The held-out test suite (P7-HELDOUT-01, `techniques/42`, ADR-0037).
 *
 * Distinct from `held-out.ts`, which holds out *acceptance criteria* from the
 * actor who authored the implementation (P3-GATE-09). This holds out *test
 * files* from the **repair loop** — a different reader, a different leak
 * surface, and the one that `ci-repair.ts` cannot cover on its own.
 *
 * Why it is needed at all: every check the repair loop is graded on today is a
 * check the loop can read and edit. `repairIsLegitimate` catches the crude
 * evasions — a deleted file, a `.skip`, a narrowed glob — but each of those
 * compares the suite against *itself*, so a repair that reshapes the code to fit
 * the tests rather than the tests to fit the code passes all of them and is
 * indistinguishable from a real fix. The only honest measure is a set of tests
 * the loop never saw.
 *
 * **The exclusion is structural, not conventional.** One predicate,
 * {@link isHeldOutPath}, and every surface that could leak the set derives its
 * answer from it: the retriever, the context pack, the agent's file scope, and
 * the runner's include globs. A convention — "we don't put held-out tests in a
 * pack" — is one careless glob from being false, and the failure is silent: the
 * pack renders, the agent answers, the number stops meaning anything, and
 * nothing reports a problem.
 *
 * **A leak is an error, not a filter, everywhere it can be.** Quietly dropping a
 * held-out path is a bug that keeps working. {@link assertNoHeldOutPaths} is
 * therefore the default response, and the deliberate exception is retrieval,
 * which legitimately over-fetches from a corpus it does not curate — there,
 * filtering is correct and the *count* is carried out so a non-zero one is
 * visible rather than comfortable.
 */

/** Where a workspace keeps the tests its repair loop must never see. */
export const DEFAULT_HELD_OUT_ROOT = 'tests/held-out';

/** Posix and lowercase, so a Windows path and a mixed-case one compare alike. */
function normalisePath(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a path belongs to the held-out set.
 *
 * Matches the root and anything beneath it, **on a path boundary only**:
 * `tests/held-outside/x` is not held out, and a bare `startsWith` would have
 * said it was. The two ways to get this wrong are not symmetric — too strict
 * hides an ordinary file from the agent and someone notices within minutes; too
 * loose leaks the set and nothing ever says so.
 */
export function isHeldOutPath(candidate: string, root: string = DEFAULT_HELD_OUT_ROOT): boolean {
  const needle = normalisePath(root);
  if (needle === '') return false;
  const value = normalisePath(candidate);
  return value === needle || value.startsWith(`${needle}/`);
}

/**
 * A chunk id names its source (`<path>#<index>`), so held-out content is
 * recognisable in the retriever's own vocabulary rather than through a second
 * convention that could disagree with the first.
 */
export function isHeldOutChunk(chunkId: string, root: string = DEFAULT_HELD_OUT_ROOT): boolean {
  return isHeldOutPath(chunkId.split('#')[0] ?? chunkId, root);
}

/**
 * The held-out root for a workspace, from its config.
 *
 * One resolver, so "where is the held-out set" has a single answer that every
 * surface asks the same way. A caller that reached into `config.testing`
 * directly would be a second place the default lives, and defaults that live in
 * two places disagree the first time one of them moves.
 */
export function heldOutRootOf(
  config: { readonly testing?: { readonly held_out_root?: string | undefined } } | null | undefined,
): string {
  const configured = config?.testing?.held_out_root?.trim();
  return configured === undefined || configured === '' ? DEFAULT_HELD_OUT_ROOT : configured;
}

export interface HeldOutPartition<T> {
  readonly visible: readonly T[];
  readonly heldOut: readonly T[];
}

export function partitionHeldOut<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  root: string = DEFAULT_HELD_OUT_ROOT,
): HeldOutPartition<T> {
  const visible: T[] = [];
  const heldOut: T[] = [];
  for (const item of items) (isHeldOutPath(pathOf(item), root) ? heldOut : visible).push(item);
  return { visible, heldOut };
}

/**
 * Thrown where a held-out path reached somewhere it can never legitimately be.
 *
 * Names the surface: "a held-out path leaked" without saying *into what* leaves
 * somebody reading four subsystems to find it.
 */
export class HeldOutLeakError extends Error {
  override readonly name = 'HeldOutLeakError';
  constructor(
    readonly surface: string,
    readonly paths: readonly string[],
  ) {
    super(
      `held-out paths reached ${surface}: ${paths.join(', ')} — the set measures the repair loop only while nothing under it is readable by the loop being measured (P7-HELDOUT-01)`,
    );
  }
}

/** Refuses rather than filters. See the note at the top of this file. */
export function assertNoHeldOutPaths(
  surface: string,
  paths: readonly string[],
  root: string = DEFAULT_HELD_OUT_ROOT,
): void {
  const leaked = paths.filter((candidate) => isHeldOutPath(candidate, root));
  if (leaked.length > 0) throw new HeldOutLeakError(surface, leaked);
}

/**
 * Globs that keep the held-out set out of a runner's default include.
 *
 * Derived rather than typed into a config file. A hand-written `exclude` entry
 * in `vitest.config.ts` is exactly the convention this task replaces: it agrees
 * with the root right up until somebody moves the root.
 */
export function heldOutExcludeGlobs(root: string = DEFAULT_HELD_OUT_ROOT): readonly string[] {
  const needle = normalisePath(root);
  return [`${needle}/**`, `**/${needle}/**`];
}

/** The glob selecting *only* the held-out set — what the daemon runs, and nothing else. */
export function heldOutIncludeGlob(root: string = DEFAULT_HELD_OUT_ROOT): string {
  return `${normalisePath(root)}/**/*.test.*`;
}

/**
 * The surfaces that must never carry a held-out path, named.
 *
 * Enumerated as data so the leak test can iterate them and a new surface has an
 * obvious place to be added — rather than four `assertNoHeldOutPaths` calls
 * scattered across three packages with nothing tying them together.
 */
export const LEAK_SURFACES = [
  'context-pack',
  'agent-file-scope',
  'agent-verify-command',
  'retrieval-index',
] as const;
export type LeakSurface = (typeof LEAK_SURFACES)[number];

export interface SuiteScope {
  /** What the agent may read. */
  readonly visible: readonly string[];
  /** What was withheld, and therefore how much. */
  readonly withheld: readonly string[];
}

/**
 * Narrows a file list so it cannot reach the held-out set.
 *
 * Applied to the *result* of whatever glob a skill declares, rather than asking
 * skill authors to remember an exclusion. An author who forgets is the failure
 * mode, so the exclusion cannot be theirs to remember.
 */
export function scopeToVisible(
  paths: readonly string[],
  root: string = DEFAULT_HELD_OUT_ROOT,
): SuiteScope {
  const { visible, heldOut } = partitionHeldOut(paths, (candidate) => candidate, root);
  return { visible, withheld: heldOut };
}

export function formatSuiteScope(scope: SuiteScope): string {
  if (scope.withheld.length === 0) return 'nothing held out of this scope';
  return `${String(scope.withheld.length)} path(s) withheld from the agent's scope — held-out suite`;
}

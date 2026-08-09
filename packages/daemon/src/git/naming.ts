/**
 * Branch naming and change classification — the pure half of the Git Manager.
 *
 * Kept free of `simple-git` so it can be tested without a repository, and so the
 * rules that decide *what* a commit is stay separable from the code that makes
 * one. Both are deterministic disposers (ADR-0040): nothing here asks a model
 * whether a change is bookkeeping or what a branch should be called.
 */

/** Conventional-commit types that may prefix a branch (conventions.md). */
export const BRANCH_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test'] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

/** Maximum length of any single slug segment in a branch name. */
export const SLUG_MAX_LENGTH = 24;

/**
 * Workspace paths the tool manages, per contracts/06-workspace-layout.md.
 * `.sdlc/` is the pre-ADR-0043 layout, retained so a workspace scaffolded under
 * the old shape still classifies correctly.
 */
export const DEFAULT_MANAGED_PREFIXES = ['kanban/', 'docs/', '.sdlcof/', '.sdlc/'] as const;

/**
 * Normalises free text into a branch-safe slug: lowercase, alphanumeric words
 * joined by hyphens, truncated at a word boundary where possible.
 *
 * Truncation trims a trailing partial word rather than cutting mid-word, because
 * `add-csv-exp` reads like a typo while `add-csv` reads like an abbreviation.
 */
export function slugify(input: string, maxLength = SLUG_MAX_LENGTH): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length <= maxLength) return cleaned;

  const truncated = cleaned.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf('-');
  return (lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated).replace(/-+$/, '');
}

export interface BranchNameParts {
  readonly type: BranchType;
  /** Epic slug, when the item sits under one. */
  readonly epic?: string | undefined;
  /** Feature or sprint slug, when the item sits under one. */
  readonly feature?: string | undefined;
  /** The stable anchor — a work-item or build-plan task ID. */
  readonly taskId: string;
  /** Short description of the work. */
  readonly slug: string;
}

/**
 * Builds `<type>/<epic>-<feature>-<task-id>-<slug>` per ADR-0048, omitting the
 * hierarchy segments an item does not have.
 *
 * The task ID is preserved verbatim and never slugified — it is the anchor that
 * makes a branch traceable back to its work item without a lookup, so lowercasing
 * it would break `git log --grep`.
 */
export function buildBranchName(parts: BranchNameParts): string {
  const segments = [
    parts.epic !== undefined ? slugify(parts.epic) : '',
    parts.feature !== undefined ? slugify(parts.feature) : '',
    parts.taskId,
    slugify(parts.slug),
  ].filter((segment) => segment.length > 0);

  return `${parts.type}/${segments.join('-')}`;
}

export interface ClassifiedChanges {
  /** Paths under a tool-managed prefix — the bookkeeping surface. */
  readonly managed: readonly string[];
  /** Everything else — real product code. */
  readonly product: readonly string[];
}

function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Splits changed paths into tool-managed bookkeeping and product code.
 *
 * This is what lets `git log` be filtered down to product history without a
 * separate branch or ref: a frontmatter status flip and a real code change are
 * mechanically distinguishable rather than a matter of commit-message discipline.
 */
export function classifyChanges(
  paths: readonly string[],
  managedPrefixes: readonly string[] = DEFAULT_MANAGED_PREFIXES,
): ClassifiedChanges {
  const managed: string[] = [];
  const product: string[] = [];

  for (const raw of paths) {
    const filePath = normalise(raw);
    if (managedPrefixes.some((prefix) => filePath.startsWith(prefix))) {
      managed.push(filePath);
    } else {
      product.push(filePath);
    }
  }

  return { managed, product };
}

/**
 * Whether a change set touches only tool-managed paths.
 *
 * An empty change set is deliberately **not** bookkeeping — there is nothing to
 * commit, and reporting "bookkeeping" for it would let an empty commit acquire a
 * trailer that claims it changed workspace state.
 */
export function isBookkeepingOnly(
  paths: readonly string[],
  managedPrefixes: readonly string[] = DEFAULT_MANAGED_PREFIXES,
): boolean {
  if (paths.length === 0) return false;
  return classifyChanges(paths, managedPrefixes).product.length === 0;
}

/** The trailer marking a commit as workspace bookkeeping (conventions.md). */
export const BOOKKEEPING_TRAILER = 'Sdlc-Bookkeeping: true';

/**
 * Appends the bookkeeping trailer, separated by a blank line, unless the message
 * already carries it. Idempotent so a caller that pre-formats its own message
 * does not end up with the trailer twice.
 */
export function withBookkeepingTrailer(message: string): string {
  const trimmed = message.trimEnd();
  if (trimmed.split('\n').some((line) => line.trim() === BOOKKEEPING_TRAILER)) {
    return trimmed;
  }
  return `${trimmed}\n\n${BOOKKEEPING_TRAILER}`;
}

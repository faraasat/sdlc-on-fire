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
 * A git trailer line: `Key: value`, where the key is a hyphenated token.
 *
 * This is the shape `git interpret-trailers` recognises, and it matters that we
 * match it rather than approximate it: a line git does not parse as a trailer is
 * ordinary prose, so a provenance record written in a shape git cannot read is
 * not queryable, which was the entire point of writing it.
 */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s.+$/;

/**
 * Splits a message into its body and its existing trailer block.
 *
 * Git only recognises trailers in the **last paragraph**, and only when that
 * paragraph is trailers throughout. Appending a second trailer paragraph would
 * therefore hide the first from every `git log --format=%(trailers)` query — so
 * trailers are merged into one block rather than stacked.
 */
function splitTrailers(message: string): { body: string; trailers: string[] } {
  const trimmed = message.trimEnd();
  const paragraphs = trimmed.split(/\n\s*\n/);
  const last = paragraphs.at(-1);
  if (paragraphs.length < 2 || last === undefined) return { body: trimmed, trailers: [] };

  const lines = last.split('\n').map((line) => line.trim());
  if (lines.length === 0 || !lines.every((line) => TRAILER_LINE.test(line))) {
    return { body: trimmed, trailers: [] };
  }
  return { body: paragraphs.slice(0, -1).join('\n\n'), trailers: lines };
}

/**
 * Appends trailers into the message's single trailer block, preserving order and
 * dropping exact duplicates.
 *
 * Idempotent, because callers pre-format their own messages and a commit that
 * declared its provenance twice would read as two different assistants.
 */
export function withTrailers(message: string, additions: readonly string[]): string {
  const { body, trailers } = splitTrailers(message);
  const merged = [...trailers];
  for (const addition of additions) {
    const line = addition.trim();
    if (line !== '' && !merged.includes(line)) merged.push(line);
  }
  if (merged.length === 0) return body;
  return `${body}\n\n${merged.join('\n')}`;
}

/**
 * Appends the bookkeeping trailer, unless the message already carries it.
 */
export function withBookkeepingTrailer(message: string): string {
  return withTrailers(message, [BOOKKEEPING_TRAILER]);
}

/**
 * Provenance for an agent-authored commit (ADR-0041, techniques/27 §2.3).
 *
 * `Assisted-by`, not `Co-authored-by`. The distinction is the whole point:
 * `Co-authored-by` asserts shared *accountability*, and a model cannot be
 * accountable for anything — it cannot be asked why, cannot be corrected, and
 * will not exist in this form in six months. This trailer is a nutrition label,
 * not a name tag: it records what produced the change so the record is queryable
 * later, while accountability stays with the human whose name is on the commit.
 */
export interface Provenance {
  /** The harness that ran, e.g. `Claude-Code`. */
  readonly tool: string;
  /** The **version-pinned** model id, e.g. `claude-opus-4-5-20260101`. */
  readonly model: string;
}

export class UnpinnedModelError extends Error {
  constructor(model: string) {
    super(
      `"${model}" is not a version-pinned model id, so the trailer would not identify what actually ran. ` +
        'Two contradictory results from "the same model" are indistinguishable without a version — ' +
        'use a pinned id (e.g. `claude-opus-4-5-20260101`).',
    );
    this.name = 'UnpinnedModelError';
  }
}

/**
 * Whether a model id pins a version.
 *
 * A bare family name (`claude-opus`, `gpt-5`) is refused for the same reason
 * P1-GATE-09 refuses it on evidence: a provenance record that cannot distinguish
 * one release from the next answers no question anyone will actually ask of it.
 * The rule is deliberately shallow — a trailing date stamp or numeric version —
 * because a vendor-specific allowlist goes stale faster than the models do.
 */
export function isPinnedModelId(model: string): boolean {
  return /\d/.test(model) && /(?:-\d{6,8}|[-.@]v?\d+(?:[-.]\d+)+|-\d+-\d+)$/.test(model.trim());
}

/** Renders `Assisted-by: TOOL:MODEL`, refusing an unpinned model. */
export function assistedByTrailer(provenance: Provenance): string {
  const tool = provenance.tool.trim();
  const model = provenance.model.trim();
  if (tool === '') throw new Error('provenance requires a tool name');
  if (!isPinnedModelId(model)) throw new UnpinnedModelError(model);
  return `Assisted-by: ${tool}:${model}`;
}

/** Reads every `Assisted-by:` trailer out of a commit message. */
export function readProvenance(message: string): Provenance[] {
  const { trailers } = splitTrailers(message);
  return trailers
    .filter((line) => line.toLowerCase().startsWith('assisted-by:'))
    .map((line) => line.slice(line.indexOf(':') + 1).trim())
    .map((value) => {
      const separator = value.indexOf(':');
      return separator === -1
        ? { tool: value, model: '' }
        : { tool: value.slice(0, separator).trim(), model: value.slice(separator + 1).trim() };
    });
}

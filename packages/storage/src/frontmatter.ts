import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * Frontmatter parsing and **deterministic** re-serialization.
 *
 * Determinism is the whole point. Every write goes through here, and a writer
 * that reorders keys or reflows quoting turns a one-field status flip into a
 * whole-file diff — which makes `git blame` useless on exactly the files the
 * tool touches most.
 *
 * The delimiter split is owned here rather than delegated (ADR-0069), so the
 * emitted bytes are ours to guarantee.
 */

/** The `---` fence. Only the opening fence at byte 0 counts as frontmatter. */
const FENCE = '---';

export interface ParsedDocument {
  /** Parsed frontmatter, or `{}` when the file has none. */
  readonly data: Record<string, unknown>;
  /** Everything after the closing fence, verbatim. */
  readonly body: string;
  readonly hasFrontmatter: boolean;
}

export class FrontmatterError extends Error {
  override readonly name = 'FrontmatterError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Canonical key order for work-item frontmatter, mirroring
 * contracts/02-object-model.md §2.2's field table.
 *
 * Keys not listed here sort alphabetically after these, so an unrecognised field
 * still lands somewhere stable rather than wherever the last writer left it.
 */
export const CANONICAL_KEY_ORDER: readonly string[] = [
  '$schema',
  'id',
  'kind',
  'title',
  'status',
  'lifecycle_state',
  'work_type',
  'preset',
  'risk_level',
  'parent_id',
  'assignee',
  'labels',
  // kind-specific fields sit here, in the order contract §2.3 lists them
  'goal',
  'entry_stage',
  'acceptance_criteria',
  'spec_ref',
  'repro_steps',
  'severity',
  'wave',
  'verify',
  'done',
  'checkpoint',
  'file_ownership',
  // relationships last — they are the least-read fields when skimming a file
  'relates_to',
  'blocks',
  'blocked_by',
  'supersedes',
  'corrects',
  'external_ref',
  'created_at',
  'updated_at',
];

/**
 * Orders keys canonically: known fields in contract order, then everything else
 * alphabetically. Pure and total — an object with no known keys still comes back
 * in a stable order.
 */
export function orderKeys(data: Record<string, unknown>): string[] {
  const rank = new Map(CANONICAL_KEY_ORDER.map((key, index) => [key, index]));
  return Object.keys(data).sort((a, b) => {
    const rankA = rank.get(a);
    const rankB = rank.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Splits a Markdown file into frontmatter and body.
 *
 * A file without an opening fence at byte 0 is not an error — plenty of managed
 * Markdown carries no frontmatter — but an *unterminated* fence is, because
 * silently treating the whole document as YAML would destroy it on the next write.
 */
export function parseFrontmatter(raw: string): ParsedDocument {
  // Strip a BOM so a Windows-authored file is not mistaken for body-only.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith(`${FENCE}\n`) && normalised.trimEnd() !== FENCE) {
    if (!normalised.startsWith(`${FENCE}\n`)) {
      return { data: {}, body: text, hasFrontmatter: false };
    }
  }

  const closing = normalised.indexOf(`\n${FENCE}`, FENCE.length);
  if (closing === -1) {
    throw new FrontmatterError(
      'frontmatter fence was opened but never closed — refusing to guess where it ends',
    );
  }

  const yamlSource = normalised.slice(FENCE.length + 1, closing);
  // Strip the newline that ends the closing fence line, then the single blank
  // line the canonical form puts between fence and body. Leading blank lines are
  // insignificant in Markdown and are not preserved — the canonical form owns
  // that gap, so a round trip is stable rather than growing a newline each pass.
  let afterFence = normalised.slice(closing + 1 + FENCE.length);
  if (afterFence.startsWith('\n')) afterFence = afterFence.slice(1);
  if (afterFence.startsWith('\n')) afterFence = afterFence.slice(1);
  const body = afterFence;

  let data: unknown;
  try {
    data = parseYaml(yamlSource) ?? {};
  } catch (cause) {
    throw new FrontmatterError(`frontmatter is not valid YAML: ${(cause as Error).message}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new FrontmatterError('frontmatter must be a YAML mapping');
  }

  return { data: data as Record<string, unknown>, body, hasFrontmatter: true };
}

export interface SerializeOptions {
  /** Emit a trailing newline (the default — POSIX text files end in one). */
  readonly trailingNewline?: boolean | undefined;
}

/**
 * Renders frontmatter + body back to a string, byte-stable for a given input.
 *
 * `undefined` values are dropped rather than emitted as `null`: a field the
 * object model treats as absent must not come back as an explicit null on the
 * next read, or every round trip would grow the file.
 */
export function serializeFrontmatter(
  data: Record<string, unknown>,
  body: string,
  options?: SerializeOptions,
): string {
  const ordered: Record<string, unknown> = {};
  for (const key of orderKeys(data)) {
    const value = data[key];
    if (value !== undefined) ordered[key] = value;
  }

  const yaml = stringifyYaml(ordered, {
    // Stable, diff-friendly output: no line reflowing, consistent quoting, and
    // block style for nested structures.
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    singleQuote: false,
    nullStr: 'null',
  });

  const normalisedBody = body.replace(/\r\n/g, '\n');
  const trimmedBody = normalisedBody.replace(/^\n+/, '');
  const bodyPart = trimmedBody.replace(/\n+$/, '');
  // The closing fence already ends in a newline, so a body-less document is
  // complete as-is; appending another would make every empty-body write differ
  // from its own re-read.
  if (bodyPart.length === 0) return `${FENCE}\n${yaml}${FENCE}\n`;

  const trailing = options?.trailingNewline === false ? '' : '\n';
  return `${FENCE}\n${yaml}${FENCE}\n\n${bodyPart}${trailing}`;
}

/**
 * Whether re-serializing a document reproduces it byte for byte.
 *
 * Used by the round-trip tests and available to callers that want to know
 * whether a file is already in canonical form before rewriting it — rewriting a
 * file that is already canonical is a pointless diff.
 */
export function isCanonical(raw: string): boolean {
  const parsed = parseFrontmatter(raw);
  if (!parsed.hasFrontmatter) return true;
  return serializeFrontmatter(parsed.data, parsed.body) === raw.replace(/\r\n/g, '\n');
}

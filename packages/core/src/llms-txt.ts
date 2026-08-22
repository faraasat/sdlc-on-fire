/**
 * `llms.txt` as a compile target (P4-DOC-02, ADR-0074).
 *
 * A flat index of a project's documentation at a well-known path, written for a
 * model with a token budget rather than a person with a scrollbar.
 *
 * **Justified on authoring grounds only, and the distinction matters.**
 * `techniques/41` §5 records what is and is not established: Anthropic publishes
 * one, Google has said it will not support it, Perplexity reportedly reads it —
 * and *nobody has demonstrated that publishing one gets you cited*. So this is
 * not a visibility intervention and must not be described as one. It is
 * defensible because the strongest real use case is precisely ours: an AI coding
 * assistant retrieving a project's docs, where a compact index cuts token waste
 * by pointing at the right page. That use case depends on no search engine
 * honouring anything.
 *
 * **Compiled, never hand-edited.** It is derived from the same `DocRecord` walk
 * that feeds freshness, health and visibility, so the four always describe one
 * corpus. A hand-maintained index is a second list of the documentation, and a
 * second list goes stale the first time somebody adds a file — which is the
 * exact failure `doc-freshness` exists to catch, reintroduced one level up.
 */

/** The subset of a doc this compiler needs. Structurally satisfied by `DocRecord`. */
export interface LlmsTxtDoc {
  readonly path: string;
  /** First heading, when the doc has one. */
  readonly title?: string | null | undefined;
  /** One-line description, when the doc declares one. */
  readonly summary?: string | null | undefined;
  /** Where this doc belongs in the index. Defaults to `Documentation`. */
  readonly section?: string | null | undefined;
}

export interface LlmsTxtInput {
  readonly project: string;
  /** One sentence describing the project. Rendered as the blockquote. */
  readonly summary?: string | null | undefined;
  readonly docs: readonly LlmsTxtDoc[];
  /** Prefix for links, e.g. a docs site origin. Relative paths when absent. */
  readonly baseUrl?: string | null | undefined;
}

/** Sections in a stable order, with anything unrecognised last. */
const SECTION_ORDER = ['Docs', 'Documentation', 'Reference', 'Decisions', 'Research'];

function sectionRank(name: string): number {
  const index = SECTION_ORDER.indexOf(name);
  return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Turn a path into a link.
 *
 * Relative when no base URL is configured, because a file:// or invented origin
 * would be worse than a relative path — a reader resolving it against the wrong
 * host gets a 404 rather than a document, and a relative link at least composes
 * with wherever the file is actually served.
 */
function link(path: string, baseUrl: string | null | undefined): string {
  if (baseUrl === null || baseUrl === undefined || baseUrl === '') return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** A doc's display name: its declared title, else its filename without extension. */
export function titleFor(doc: LlmsTxtDoc): string {
  const declared = doc.title ?? null;
  if (declared !== null && declared.trim() !== '') return declared.trim();
  const base = doc.path.split('/').pop() ?? doc.path;
  return base.replace(/\.md$/i, '');
}

/**
 * Compile the index.
 *
 * The shape follows the convention the published examples use: an H1 with the
 * project name, an optional blockquote summary, then `##` sections of links.
 * Deterministic throughout — sections in a fixed order, docs sorted by title
 * within a section — because this is a generated file that will be committed,
 * and a generator whose output depends on directory order produces a diff every
 * time anyone runs it.
 */
export function compileLlmsTxt(input: LlmsTxtInput): string {
  const lines: string[] = [`# ${input.project}`];

  if (input.summary != null && input.summary.trim() !== '') {
    lines.push('', `> ${input.summary.trim()}`);
  }

  const bySection = new Map<string, LlmsTxtDoc[]>();
  for (const doc of input.docs) {
    const section =
      doc.section != null && doc.section.trim() !== '' ? doc.section.trim() : 'Documentation';
    const group = bySection.get(section) ?? [];
    group.push(doc);
    bySection.set(section, group);
  }

  const sections = [...bySection.entries()].sort(
    ([a], [b]) => sectionRank(a) - sectionRank(b) || a.localeCompare(b),
  );

  for (const [section, docs] of sections) {
    lines.push('', `## ${section}`, '');
    const sorted = [...docs].sort(
      (a, b) => titleFor(a).localeCompare(titleFor(b)) || a.path.localeCompare(b.path),
    );
    for (const doc of sorted) {
      const summary =
        doc.summary != null && doc.summary.trim() !== '' ? `: ${doc.summary.trim()}` : '';
      lines.push(`- [${titleFor(doc)}](${link(doc.path, input.baseUrl)})${summary}`);
    }
  }

  // Trailing newline: this is a file on disk, and a generator that omits one
  // produces a diff against every editor that adds it back.
  return `${lines.join('\n')}\n`;
}

/** The path the convention puts it at. Not configurable — "well-known" is the feature. */
export const LLMS_TXT_PATH = 'llms.txt';

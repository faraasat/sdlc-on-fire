/**
 * The doc-health check (P1-DOC-02, ADR-0053/0050).
 *
 * ADR-0053's rules are about what a *corpus* costs an agent to read, which is a
 * different question from whether any one doc is current (P1-DOC-01's job). Three
 * things make a corpus expensive:
 *
 * - **An orphan** — a doc no index points at. It is retrievable and undiscovered:
 *   the agent that needed it never learned it existed, and the human who wrote it
 *   believes it is doing work.
 * - **A missing index** — a folder with no README is a folder an agent has to
 *   scan, which is precisely what index-first exists to avoid.
 * - **Redundancy** — the same fact stated in two places. ADR-0053 calls
 *   duplicated prose a defect, and the reason is not tidiness: two copies
 *   disagree eventually, and nothing says which one is wrong.
 *
 * All three **advise**. Redundancy detection is lexical, so it cannot tell a
 * genuine duplicate from two docs that legitimately quote the same contract, and
 * a check that fails builds on that guess would get switched off within a week.
 */

export type HealthIssue = 'orphan' | 'missing-index' | 'redundant-section';

export interface HealthFinding {
  readonly issue: HealthIssue;
  readonly doc: string;
  readonly detail: string;
  /** The other doc, for redundancy. */
  readonly counterpart?: string | undefined;
}

export interface DocNode {
  readonly path: string;
  /** Docs this one links to. */
  readonly links: readonly string[];
  /** Section headings with their body text, for redundancy comparison. */
  readonly sections?: readonly { readonly heading: string; readonly body: string }[] | undefined;
}

/** Files that serve as an index for their folder. */
export const INDEX_NAMES = ['README.md', 'index.md', '00-README.md'];

export function isIndex(docPath: string): boolean {
  return INDEX_NAMES.includes(docPath.split('/').at(-1) ?? '');
}

/** Share of shared content words above which two sections are called redundant. */
export const REDUNDANCY_THRESHOLD = 0.8;
/** Below this many words a section is too short for the overlap number to mean anything. */
export const MIN_SECTION_WORDS = 25;

export interface HealthReport {
  readonly findings: readonly HealthFinding[];
  /** Always true. Every finding here is advisory — see the module note. */
  readonly ok: true;
}

/**
 * Reports corpus-level problems.
 *
 * Pure. The corpus arrives already read, so the same input always produces the
 * same report — and a caller can run it over a proposed tree as easily as an
 * existing one.
 */
export function checkDocHealth(docs: readonly DocNode[]): HealthReport {
  const findings: HealthFinding[] = [];
  const linkedTo = new Set(docs.flatMap((doc) => doc.links));

  for (const doc of docs) {
    // An index is reached by its folder, not by a link, so it is never an
    // orphan — flagging every README would drown the signal that matters.
    if (!isIndex(doc.path) && !linkedTo.has(doc.path)) {
      findings.push({
        issue: 'orphan',
        doc: doc.path,
        detail: 'no index or doc links here — retrievable, and undiscovered',
      });
    }
  }

  const folders = new Set(docs.map((doc) => doc.path.split('/').slice(0, -1).join('/')));
  const indexed = new Set(
    docs
      .filter((doc) => isIndex(doc.path))
      .map((doc) => doc.path.split('/').slice(0, -1).join('/')),
  );
  for (const folder of [...folders].sort()) {
    if (folder !== '' && !indexed.has(folder)) {
      findings.push({
        issue: 'missing-index',
        doc: folder,
        detail: 'no README — an agent has to scan this folder rather than being pointed at one doc',
      });
    }
  }

  findings.push(...redundancies(docs));
  return { findings, ok: true };
}

function redundancies(docs: readonly DocNode[]): HealthFinding[] {
  const sections = docs.flatMap((doc) =>
    (doc.sections ?? []).map((section) => ({ doc: doc.path, ...section })),
  );
  const findings: HealthFinding[] = [];

  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const a = sections[i] as (typeof sections)[number];
      const b = sections[j] as (typeof sections)[number];
      if (a.doc === b.doc) continue;
      const overlap = wordOverlap(a.body, b.body);
      if (overlap >= REDUNDANCY_THRESHOLD) {
        findings.push({
          issue: 'redundant-section',
          doc: a.doc,
          counterpart: b.doc,
          // Two copies disagree eventually, and nothing says which is wrong.
          detail: `"${a.heading}" and "${b.heading}" share ${(overlap * 100).toFixed(0)}% of their content — one should link to the other`,
        });
      }
    }
  }
  return findings;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function wordOverlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  // Two short sections share vocabulary by chance. Calling that redundancy
  // would fill the report with pairs nobody would merge.
  if (left.length < MIN_SECTION_WORDS || right.length < MIN_SECTION_WORDS) return 0;
  const inRight = new Set(right);
  const shared = left.filter((word) => inRight.has(word)).length;
  return shared / left.length;
}

/* ------------------------------------------------------- decision-record homes */

export type DecisionHome = 'global' | 'initiative';

/**
 * Which home a decision belongs in (ADR-0050).
 *
 * One question, and it is not about importance: **does this constrain work
 * outside its initiative?** A decision that feels significant but binds only one
 * epic is initiative-local, and putting it globally would make the global index
 * a list of everything anyone ever decided — which is how an index stops being
 * read.
 */
export function decisionHome(input: {
  readonly constrainsOtherInitiatives: boolean;
}): DecisionHome {
  return input.constrainsOtherInitiatives ? 'global' : 'initiative';
}

/**
 * Whether an initiative-local decision has outgrown its home.
 *
 * Promotion writes a *superseding global ADR that references the local one*
 * (ADR-0050) rather than moving the file: the local record is what the
 * initiative actually decided at the time, and rewriting history to make it look
 * global would lose when the scope changed.
 */
export function needsPromotion(input: {
  readonly home: DecisionHome;
  readonly constrainsOtherInitiatives: boolean;
}): boolean {
  return input.home === 'initiative' && input.constrainsOtherInitiatives;
}

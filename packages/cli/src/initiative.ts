import fs from 'node:fs/promises';
import path from 'node:path';
import { INITIATIVE_FILES, relativePosix, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import {
  checkDiagram,
  checkDocHealth,
  checkReadability,
  type DiagramFinding,
  type HealthReport,
  type ReadabilityReport,
} from '@sdlc-on-fire/evidence';
import { readDocs } from './docs-check.js';

/**
 * `sdlc initiative` and `sdlc doc-health` (P1-DOC-02, ADR-0050/0053).
 *
 * A plan folder is scaffolded whole — `decisions/`, `qna.md`, `human-loop.md`,
 * `VERIFICATION.md`, `UAT.md` — rather than created file by file as each is
 * first needed. The files that get created lazily are the ones that never get
 * created: nobody opens an empty initiative and thinks "this needs a UAT file",
 * and the absence reads as "UAT did not apply" rather than "nobody did it."
 */

export const INITIATIVE_KINDS = ['epic', 'sprint', 'feature'] as const;
export type InitiativeKind = (typeof INITIATIVE_KINDS)[number];

export interface InitiativeResult {
  readonly dir: string;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Creates a dated plan folder.
 *
 * The date is the caller's, not `new Date()` — an initiative created while
 * back-filling should carry the date it belongs to, and a folder name that
 * silently means "whenever this command ran" is a name that lies later.
 */
export async function createInitiative(
  root: string,
  input: { readonly kind: InitiativeKind; readonly title: string; readonly date: string },
): Promise<InitiativeResult> {
  const layout = resolveWorkspaceLayout(root);
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const dir = path.join(layout.docsDir, '.plan', `plan-${input.date}-${input.kind}-${slug}`);

  await fs.mkdir(path.join(dir, 'decisions'), { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];

  const files: Record<string, string> = {
    ...INITIATIVE_FILES,
    'decisions/README.md':
      '# Decisions\n\nCalls made inside this initiative. A decision that turns out to\n' +
      'constrain work **outside** it is promoted to `docs/architectural-design-decisions/`\n' +
      'by a superseding global ADR that references the one here — the local record stays,\n' +
      'because it is what this initiative actually decided at the time (ADR-0050).\n',
  };

  for (const [name, template] of Object.entries(files)) {
    const file = path.join(dir, name);
    const contents = template.replace('{title}', input.title);
    try {
      await fs.writeFile(file, contents, { flag: 'wx' });
      created.push(relativePosix(layout.root, file));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(relativePosix(layout.root, file));
      } else throw cause;
    }
  }

  return { dir: relativePosix(layout.root, dir), created, skipped };
}

export interface DocHealthResult {
  readonly report: HealthReport;
  readonly docsScanned: number;
}

/** Runs the corpus-level check over the workspace's docs. */
export async function docHealth(root: string): Promise<DocHealthResult> {
  const layout = resolveWorkspaceLayout(root);
  const docs = await readDocs(root);
  const nodes = await Promise.all(
    docs.map(async (doc) => {
      const raw = await fs.readFile(path.join(layout.root, doc.path), 'utf8').catch(() => '');
      return {
        path: doc.path,
        links: (doc.links ?? [])
          .filter((link) => link.resolves)
          // Compared against the other nodes' `path`, so it must be spelled the
          // same way they are — a native-separator edge points at no node and
          // every doc reads as an orphan.
          .map((link) =>
            relativePosix(
              layout.root,
              path.resolve(path.dirname(path.join(layout.root, doc.path)), link.target),
            ),
          ),
        sections: sectionsOf(raw),
      };
    }),
  );
  return { report: checkDocHealth(nodes), docsScanned: nodes.length };
}

/** Splits on headings, so redundancy is compared section-to-section, not file-to-file. */
function sectionsOf(raw: string): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [];
  let heading = '(preamble)';
  let body: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match !== null) {
      if (body.join('').trim() !== '') sections.push({ heading, body: body.join('\n') });
      heading = (match[1] ?? '').trim();
      body = [];
    } else body.push(line);
  }
  if (body.join('').trim() !== '') sections.push({ heading, body: body.join('\n') });
  return sections;
}

/** Report. Every finding here advises; the text says so rather than implying it. */
export function formatDocHealth(result: DocHealthResult): string {
  const lines = [`Doc health — ${String(result.docsScanned)} doc(s)`, ''];
  for (const finding of result.report.findings) {
    const other = finding.counterpart === undefined ? '' : ` ↔ ${finding.counterpart}`;
    lines.push(`⚠️  [${finding.issue}] ${finding.doc}${other}: ${finding.detail}`);
  }
  if (result.report.findings.length === 0) lines.push('✅ Nothing to report.');
  else {
    lines.push('');
    lines.push('All advisory. Redundancy detection is lexical and cannot tell a real');
    lines.push('duplicate from two docs quoting the same contract.');
  }
  return lines.join('\n');
}

export interface GuideCheckResult {
  readonly guide: string;
  readonly readability: ReadabilityReport;
  readonly diagrams: readonly {
    readonly index: number;
    readonly findings: readonly DiagramFinding[];
  }[];
  readonly ok: boolean;
}

/**
 * Checks a user guide's prose and its diagrams (P1-DOC-03, ADR-0057).
 *
 * Both halves matter and only one gates. Jargon is decidable — the word is in
 * the product's own vocabulary list or it is not — and a diagram missing its
 * accessibility hooks is a fact about the source. Sentence length and reading
 * ease are reported, because a score that failed builds would be met by
 * splitting clauses until the number moved.
 */
export async function checkGuide(root: string, relative: string): Promise<GuideCheckResult> {
  const layout = resolveWorkspaceLayout(root);
  const raw = await fs.readFile(path.join(layout.root, relative), 'utf8');
  const readability = checkReadability(raw);

  const diagrams = [...raw.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match, index) => ({
    index,
    findings: checkDiagram(match[1] ?? '', 'user'),
  }));

  return {
    guide: relative,
    readability,
    diagrams,
    ok: readability.ok && diagrams.every((entry) => entry.findings.length === 0),
  };
}

/** Report. Says which half gates, since the two read alike otherwise. */
export function formatGuideCheck(result: GuideCheckResult): string {
  const lines = [`${result.guide} — reading ease ${String(result.readability.readingEase)}`, ''];
  for (const finding of result.readability.findings) {
    const mark = finding.kind === 'jargon' ? '❌' : '⚠️ ';
    lines.push(`${mark} ${finding.kind}: ${finding.detail}`);
  }
  for (const diagram of result.diagrams) {
    for (const finding of diagram.findings) {
      lines.push(`❌ diagram ${String(diagram.index + 1)} [${finding.rule}]: ${finding.detail}`);
    }
  }
  if (result.ok) lines.push('✅ Reads plainly, and the diagrams are accessible.');
  else lines.push('', 'Jargon and diagram rules gate; sentence length is a nudge.');
  return lines.join('\n');
}

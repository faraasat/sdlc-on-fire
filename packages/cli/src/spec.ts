import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import {
  archivePath,
  blocks,
  changePath,
  findKeywords,
  parseScenarios,
  relativePosix,
  resolveWorkspaceLayout,
  specPath,
  validateSpec,
  type AuthoredRequirement,
  type DeltaKind,
  type SpecProblem,
} from '@sdlc-on-fire/core';

/**
 * `sdlc spec` and `sdlc change` — native brownfield authoring (P4-BROWN-01).
 *
 * The delta model, written by us rather than parsed from OpenSpec: `specs/`
 * holds the current truth, `changes/<id>/` holds a proposal against it, and
 * landing a change moves it to `changes/archive/` rather than deleting it.
 *
 * Validation refuses on exactly two things — a requirement that cannot be
 * violated and a scenario that cannot fail — and advises on everything else.
 * A spec is prose somebody has to live with, and a validator that argues about
 * style is one they turn off, taking the two refusals with it.
 */

const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
const DELTA_SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;

/**
 * Split a spec or proposal into requirements.
 *
 * Shares its heading grammar with the OpenSpec importer deliberately: the whole
 * premise of P4-BROWN-01 is that our native format *is* that delta model, so a
 * second grammar here would mean a document we wrote could fail to re-import
 * through our own parser.
 */
export function splitAuthored(markdown: string): readonly AuthoredRequirement[] {
  const out: AuthoredRequirement[] = [];
  let section: DeltaKind | undefined;
  let title: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (title === null) return;
    const text = body.join('\n');
    out.push({
      title,
      body: text,
      keywords: findKeywords(text),
      scenarios: parseScenarios(text),
      ...(section === undefined ? {} : { delta: section }),
    });
    title = null;
    body = [];
  };

  for (const line of markdown.split('\n')) {
    const delta = DELTA_SECTION.exec(line);
    if (delta !== null) {
      flush();
      section = (delta[1] ?? '').toUpperCase() as DeltaKind;
      continue;
    }
    const heading = REQUIREMENT.exec(line);
    if (heading !== null) {
      flush();
      title = heading[1] ?? '';
      continue;
    }
    if (title !== null) body.push(line);
  }
  flush();
  return out;
}

export interface SpecCheckResult {
  readonly files: readonly { path: string; requirements: number }[];
  readonly problems: readonly (SpecProblem & { file: string })[];
  readonly ok: boolean;
}

async function readMarkdown(dir: string, root: string): Promise<{ path: string; raw: string }[]> {
  const out: { path: string; raw: string }[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) {
        out.push({ path: relativePosix(root, full), raw: await fs.readFile(full, 'utf8') });
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Validate every spec and every open change.
 *
 * The archive is deliberately excluded. A landed change is a historical record,
 * and re-validating history means a rule added today can retroactively fail a
 * change that shipped last year — which teaches people to weaken the rule
 * rather than fix the document.
 */
export async function checkSpecs(root: string): Promise<SpecCheckResult> {
  const layout = resolveWorkspaceLayout(root);
  const base = layout.docsDir;
  const files = [
    ...(await readMarkdown(path.join(base, 'specs'), layout.root)),
    ...(await readMarkdown(path.join(base, 'changes'), layout.root)).filter(
      (file) => !file.path.includes('/archive/'),
    ),
  ];

  const problems: (SpecProblem & { file: string })[] = [];
  const summary: { path: string; requirements: number }[] = [];

  for (const file of files) {
    const front = parseFrontmatter(file.raw);
    const requirements = splitAuthored(front.body);
    summary.push({ path: file.path, requirements: requirements.length });

    // An inferred stub is a *proposal*, not a specification (P4-BROWN-02). It
    // is reported as unconfirmed, and its unwritten requirements are not run
    // through the authoring rules — telling somebody their generated
    // placeholder is missing an RFC-2119 keyword is true, useless, and would
    // bury the one message that matters under one per domain.
    //
    // This is the seam where a guess could quietly become a specification, so
    // the refusal lives here rather than in a convention about how people are
    // supposed to treat these files.
    if (front.data['inferred'] === true) {
      problems.push({
        file: file.path,
        requirement: '(whole file)',
        because:
          'inferred from the codebase and not yet confirmed — write the requirements, then delete the `inferred: true` marker',
        severity: 'refusal',
      });
      continue;
    }

    for (const problem of validateSpec(requirements))
      problems.push({ ...problem, file: file.path });
  }

  return { files: summary, problems, ok: !blocks(problems) };
}

export function formatSpecCheck(result: SpecCheckResult): string {
  if (result.files.length === 0) {
    return 'No specs or changes found. `sdlc spec new <domain>` starts one.';
  }

  const lines: string[] = [];
  const refusals = result.problems.filter((problem) => problem.severity === 'refusal');
  const advice = result.problems.filter((problem) => problem.severity === 'advice');

  const total = result.files.reduce((sum, file) => sum + file.requirements, 0);
  lines.push(`${String(total)} requirement(s) across ${String(result.files.length)} file(s).`);

  if (refusals.length > 0) {
    lines.push('', `${String(refusals.length)} refusal(s):`);
    for (const problem of refusals) {
      lines.push(`  ${problem.file} — ${problem.requirement}: ${problem.because}`);
    }
  }
  if (advice.length > 0) {
    lines.push('', `${String(advice.length)} suggestion(s):`);
    for (const problem of advice) {
      lines.push(`  ${problem.file} — ${problem.requirement}: ${problem.because}`);
    }
  }
  return lines.join('\n');
}

const SPEC_TEMPLATE = (domain: string): string =>
  [
    `# ${domain}`,
    '',
    '### Requirement: Name the obligation, not the feature',
    '',
    'The system MUST … (an RFC-2119 keyword is required — without one there is',
    'nothing a gate can check and nothing a reviewer can disagree with).',
    '',
    '- GIVEN some starting state',
    '- WHEN something happens',
    '- THEN an observable thing is true',
    '',
  ].join('\n');

const CHANGE_TEMPLATE = (id: string): string =>
  [
    `# ${id}`,
    '',
    'Why this change exists, in a sentence somebody reviewing it can disagree with.',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: …',
    '',
    'The system MUST …',
    '',
    '- GIVEN …',
    '- WHEN …',
    '- THEN …',
    '',
  ].join('\n');

export interface ScaffoldResult {
  readonly path: string;
  readonly created: boolean;
}

/** Create a spec or a change, refusing to clobber one that exists. */
export async function newSpec(root: string, domain: string): Promise<ScaffoldResult> {
  return scaffold(root, specPath(domain), SPEC_TEMPLATE(domain));
}

export async function newChange(root: string, id: string): Promise<ScaffoldResult> {
  return scaffold(root, changePath(id), CHANGE_TEMPLATE(id));
}

async function scaffold(root: string, relative: string, contents: string): Promise<ScaffoldResult> {
  const layout = resolveWorkspaceLayout(root);
  const target = path.join(layout.docsDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    // `wx` rather than a stat-then-write: the check and the write have to be one
    // operation, or two runs racing each other both see "absent" and the second
    // silently overwrites the first author's work.
    await fs.writeFile(target, contents, { flag: 'wx' });
    return { path: relative, created: true };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST')
      return { path: relative, created: false };
    throw cause;
  }
}

export interface ArchiveResult {
  readonly from: string;
  readonly to: string;
  readonly moved: boolean;
  readonly because?: string;
}

/**
 * Land a change: move it under `changes/archive/`.
 *
 * Refuses when the change does not validate. Landing an invalid delta writes it
 * into the historical record, where nothing re-validates it — so this is the
 * last moment the problem is cheap to fix.
 */
export async function archiveChange(root: string, id: string): Promise<ArchiveResult> {
  const layout = resolveWorkspaceLayout(root);
  const from = path.join(layout.docsDir, changePath(id));
  const to = path.join(layout.docsDir, archivePath(id));

  const raw = await fs.readFile(from, 'utf8').catch(() => null);
  if (raw === null) {
    return { from: changePath(id), to: archivePath(id), moved: false, because: 'no such change' };
  }

  const problems = validateSpec(splitAuthored(raw));
  if (blocks(problems)) {
    return {
      from: changePath(id),
      to: archivePath(id),
      moved: false,
      because: `does not validate: ${problems.find((p) => p.severity === 'refusal')?.because ?? ''}`,
    };
  }

  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  // The now-empty change directory is removed, but only if it is empty — a
  // change that carried extra files keeps them rather than losing them to a
  // recursive delete.
  await fs.rmdir(path.dirname(from)).catch(() => undefined);
  return { from: changePath(id), to: archivePath(id), moved: true };
}

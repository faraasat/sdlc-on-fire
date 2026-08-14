import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_REFRESH_DAYS,
  detectStack,
  evaluateTechResearch,
  refreshByFor,
  relativePosix,
  resolveWorkspaceLayout,
  staleRegistryEntries,
  TECH_RESEARCH_FILES,
  TEMPLATE_MARKERS,
  type DetectedTech,
  type RefreshCadence,
  type TechDocRecord,
  type TechResearchVerdict,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';

/**
 * `sdlc research` — the tech-research engine's reachable surface (P2-RES-01,
 * ADR-0045).
 *
 * Three commands, and the split between them is the point:
 *
 * - `scan` reads the project's manifest and reports which technologies have
 *   usable research and which do not. It never writes.
 * - `new <tech>` creates the folder skeleton, dated, with `refresh-by` already
 *   set — and deliberately **fails its own check** the moment it is created,
 *   because a freshly scaffolded folder contains template text and no sources.
 *   A generator whose output passes the checker has generated a pass.
 * - `check` is the same evaluation as `scan`, exit-coded, for a gate.
 *
 * What none of them do is research. That is a web-enabled reading task, and a
 * program claiming to have done it would be manufacturing exactly the evidence
 * ADR-0045 exists to refuse.
 */

export interface ResearchScanResult {
  readonly root: string;
  /**
   * Every manifest read, not just the root one.
   *
   * Reported because the count of technologies is meaningless without it. Run
   * against this repository, a root-only scan found **one** technology — the
   * root `package.json` of a pnpm workspace holds nothing but tooling, and
   * every real dependency (Zod, Drizzle, PGlite, Commander) lives in a
   * `packages/*` manifest. "1 technology, all researched" would have been a
   * green check over a dozen unexamined dependencies, which is the precise
   * failure this command exists to prevent, produced by the command itself.
   */
  readonly manifests: readonly string[];
  readonly detected: readonly DetectedTech[];
  readonly verdicts: readonly TechResearchVerdict[];
  /** Registry entries old enough to re-verify — this checker's own staleness. */
  readonly staleRegistry: readonly string[];
  readonly ok: boolean;
}

/** Where a technology's research folder lives, per ADR-0045. */
export const researchDirFor = (docsDir: string, tech: string): string =>
  path.join(docsDir, '.research', tech);

async function readTechDocs(dir: string): Promise<TechDocRecord[]> {
  const docs: TechDocRecord[] = [];
  for (const file of TECH_RESEARCH_FILES) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (raw === null) continue;
    const parsed = parseFrontmatter(raw);
    const sources = Array.isArray(parsed.data['sources'])
      ? parsed.data['sources'].filter((entry): entry is string => typeof entry === 'string')
      : [];

    docs.push({
      file,
      ...(typeof parsed.data['researched-on'] === 'string'
        ? { researchedOn: parsed.data['researched-on'] }
        : {}),
      ...(typeof parsed.data['refresh-by'] === 'string'
        ? { refreshBy: parsed.data['refresh-by'] }
        : {}),
      sources,
      bodyChars: parsed.body.trim().length,
      templateMarkers: TEMPLATE_MARKERS.filter((marker) => parsed.body.includes(marker)),
    });
  }
  return docs;
}

/**
 * Reads the project's manifest and judges every technology in it.
 *
 * `today` is injected rather than read from the clock — the same reason
 * `evaluateTechResearch` takes it. A staleness check nobody can test at its
 * boundary is one whose boundary nobody knows.
 */
export async function scanResearch(
  root: string,
  options: { readonly today?: string | undefined } = {},
): Promise<ResearchScanResult> {
  const layout = resolveWorkspaceLayout(root);
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  const { manifests, detected } = await detectProjectStack(layout.root);

  const verdicts: TechResearchVerdict[] = [];
  for (const tech of detected) {
    const docs = await readTechDocs(researchDirFor(layout.docsDir, tech.tech));
    verdicts.push(evaluateTechResearch(tech.tech, docs, today));
  }

  return {
    root: layout.root,
    manifests,
    detected,
    verdicts,
    staleRegistry: staleRegistryEntries(today),
    // A project with no manifest is not a passing scan — nothing was read, and
    // "no technologies found" is the same output as "no manifest found" unless
    // the difference is reported.
    ok: manifests.length > 0 && verdicts.every((verdict) => verdict.usable),
  };
}

/**
 * Every `package.json` in the project, root and workspace members.
 *
 * Members are found by walking the tree rather than by parsing workspace globs
 * from `pnpm-workspace.yaml` or `package.json#workspaces`: there are two glob
 * dialects, npm/yarn/pnpm/bun each configure it differently, and a manifest
 * missed because its glob was not understood is a dependency silently exempted
 * from the check. Walking finds the same manifests without needing to know
 * which package manager the project chose.
 */
export async function workspaceManifests(root: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.sdlcof']);

  const walk = async (dir: string, remaining: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'package.json') found.push(path.join(dir, entry.name));
      else if (entry.isDirectory() && remaining > 0 && !skip.has(entry.name)) {
        await walk(path.join(dir, entry.name), remaining - 1);
      }
    }
  };

  await walk(root, depth);
  return found.sort();
}

export interface ProjectStack {
  /** Manifests actually read, relative to the workspace root. */
  readonly manifests: readonly string[];
  readonly detected: readonly DetectedTech[];
}

/**
 * The technologies a project depends on, across every manifest in it.
 *
 * Shared rather than duplicated, and that is not tidiness. `sdlc mcp suggest`
 * grew its own copy of this walk and immediately re-introduced a defect this
 * one had already fixed: it offered to find an MCP server for the project's own
 * packages. Two callers with two ideas of "the stack" disagree eventually, and
 * the disagreement shows up as advice rather than as an error.
 */
export async function detectProjectStack(root: string): Promise<ProjectStack> {
  const manifestPaths = await workspaceManifests(root);
  const manifests: string[] = [];
  const merged = new Map<string, DetectedTech>();

  // The project's own packages are not technologies to research. In a monorepo
  // they appear in each other's `dependencies` like anything else, and the
  // first run of this against our own tree duly asked for a research folder
  // about `sdlc-on-fire`. Collected from the manifests themselves rather than
  // guessed from a name prefix, which would exempt exactly the wrong thing in a
  // project whose packages are named after a vendor it also depends on.
  const own = new Set<string>();
  const parsed = new Map<string, unknown>();
  for (const manifestPath of manifestPaths) {
    const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null);
    if (raw === null) continue;
    const manifest = JSON.parse(raw) as { name?: unknown };
    parsed.set(manifestPath, manifest);
    if (typeof manifest.name === 'string') own.add(manifest.name);
  }

  for (const manifestPath of manifestPaths) {
    const manifest = parsed.get(manifestPath);
    if (manifest === undefined) continue;
    manifests.push(relativePosix(root, manifestPath));
    for (const tech of detectStack(manifest)) {
      if (tech.packages.every((entry) => own.has(entry.name))) continue;
      const existing = merged.get(tech.tech);
      merged.set(
        tech.tech,
        existing === undefined
          ? tech
          : {
              ...existing,
              packages: [...existing.packages, ...tech.packages].filter(
                (entry, index, all) =>
                  all.findIndex((other) => other.name === entry.name) === index,
              ),
            },
      );
    }
  }
  const detected = [...merged.values()].sort((a, b) => a.tech.localeCompare(b.tech));

  return { manifests, detected };
}

export interface NewResearchResult {
  readonly tech: string;
  readonly dir: string;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly researchedOn: string;
  readonly refreshBy: string;
}

function skeleton(
  tech: string,
  file: string,
  researchedOn: string,
  refreshBy: string,
  scaffold: DetectedTech['scaffold'],
): string {
  const frontmatter = [
    '---',
    `tech: ${tech}`,
    `researched-on: ${researchedOn}`,
    `refresh-by: ${refreshBy}`,
    'sources:',
    '  # Every substantive claim below traces to one of these. A source must',
    '  # resolve; "I recall it works this way" is not one (ADR-0045).',
    '---',
    '',
  ];

  const bodies: Record<string, string[]> = {
    'docs.md': [
      `# ${tech} — overview`,
      '',
      'TODO: pinned version, the official docs index, the concepts this project',
      'relies on, and the gotchas found while reading them.',
    ],
    'optimizations.md': [
      `# ${tech} — performance, scaling, cost`,
      '',
      'TODO: guidance beyond the happy path, each claim sourced.',
    ],
    'api-contract.md': [
      `# ${tech} — the surface we depend on`,
      '',
      'TODO: the exact API, commands and config this project uses. Anything',
      'unverified stays out of this file — it is the one code gets written against.',
    ],
    'scaffold.md': [
      `# ${tech} — scaffolding`,
      '',
      ...(scaffold === undefined
        ? [
            'TODO: record the official scaffolding CLI and the page documenting it,',
            'or state explicitly that no official CLI exists and record the manual',
            'bootstrap steps taken instead (ADR-0045).',
          ]
        : [
            'Official CLI, per the registry:',
            '',
            '```bash',
            scaffold.command,
            '```',
            '',
            `Documented at ${scaffold.source} (checked ${scaffold.checkedOn}).`,
            '',
            'TODO: record the exact flags used here, and any generated files pruned',
            'afterwards, with the reason.',
          ]),
    ],
  };

  return `${[...frontmatter, ...(bodies[file] ?? [`# ${tech}`, '', 'TODO'])].join('\n')}\n`;
}

/**
 * Creates the folder skeleton for a technology.
 *
 * The generated folder **does not pass `check`**, and that is deliberate. It
 * has today's date and a `refresh-by`, so it is not stale; it has no sources
 * and it still says TODO, so it is `template`. A scaffolder whose output
 * satisfies the checker has not produced research — it has produced a pass, and
 * the next person to look sees a green check over four files of prompts.
 *
 * Existing files are never overwritten. The folder may already hold real
 * research, and regenerating over it would destroy the thing being checked for.
 */
export async function newResearch(
  root: string,
  tech: string,
  options: {
    readonly today?: string | undefined;
    readonly cadence?: RefreshCadence | undefined;
  } = {},
): Promise<NewResearchResult> {
  const layout = resolveWorkspaceLayout(root);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const refreshBy = refreshByFor(today, options.cadence ?? 'active');
  const dir = researchDirFor(layout.docsDir, tech);

  const manifest = await fs
    .readFile(path.join(layout.root, 'package.json'), 'utf8')
    .catch(() => null);
  const scaffold = (manifest === null ? [] : detectStack(JSON.parse(manifest))).find(
    (entry) => entry.tech === tech,
  )?.scaffold;

  await fs.mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of TECH_RESEARCH_FILES) {
    const full = path.join(dir, file);
    try {
      await fs.writeFile(full, skeleton(tech, file, today, refreshBy, scaffold), { flag: 'wx' });
      created.push(relativePosix(layout.root, full));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(relativePosix(layout.root, full));
      } else throw cause;
    }
  }

  return {
    tech,
    dir: relativePosix(layout.root, dir),
    created,
    skipped,
    researchedOn: today,
    refreshBy,
  };
}

export function formatResearchScan(result: ResearchScanResult): string {
  if (result.manifests.length === 0) {
    return 'no package.json found — nothing was scanned, which is not the same as nothing to research.';
  }

  const lines = [
    `${String(result.detected.length)} technolog${result.detected.length === 1 ? 'y' : 'ies'} across ${String(result.manifests.length)} manifest(s)`,
    '',
  ];

  for (const verdict of result.verdicts) {
    const mark = verdict.usable ? '✓' : '✗';
    lines.push(`  ${mark} ${verdict.tech.padEnd(24)} ${verdict.status}`);
    if (!verdict.usable) for (const detail of verdict.detail) lines.push(`      ${detail}`);
  }

  const unresearched = result.verdicts.filter((verdict) => !verdict.usable);
  if (unresearched.length > 0) {
    lines.push(
      '',
      `${String(unresearched.length)} technolog${unresearched.length === 1 ? 'y' : 'ies'} without usable research.`,
      `Start one with:  sdlc research new <tech>   (dated today, refresh-by +${String(DEFAULT_REFRESH_DAYS)} days)`,
      'The skeleton does not pass this check — it has no sources yet, and it says so.',
    );
  } else {
    lines.push('', 'Every detected technology has current, sourced research.');
  }

  if (result.staleRegistry.length > 0) {
    // This checker's own research, held to its own rule.
    lines.push(
      '',
      `⚠ scaffold-registry entries due for re-verification: ${result.staleRegistry.join(', ')}`,
    );
  }

  return lines.join('\n');
}

export function formatNewResearch(result: NewResearchResult): string {
  const lines = [
    `${result.tech} → ${result.dir}  (researched-on ${result.researchedOn}, refresh-by ${result.refreshBy})`,
  ];
  for (const file of result.created) lines.push(`  + ${file}`);
  for (const file of result.skipped) lines.push(`  · ${file} (exists, left alone)`);
  lines.push(
    '',
    'This folder does not yet count as research: no sources, and the bodies are prompts.',
    'Fill it in from the official docs and reputable third-party sources, then re-run',
    '`sdlc research check`.',
  );
  return lines.join('\n');
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { externalRefKey, IrNodeSchema, type IrNode } from './ir.js';
import type { DetectionResult, ParseResult, ParseWarning, ToolParser } from './port.js';

/**
 * The BMAD parsers (P2-IMP-06, `.research/10 §2.4`).
 *
 * **Two parsers, because v4→v6 was a rewrite.** Module renames, a reorganised
 * output folder and a sequencing change mean one parser cannot cover both. They
 * are told apart by **marker layout, not a version string** — BMAD does not
 * stamp a machine-readable version into its artifacts, so anything claiming to
 * read one would be reading a guess.
 *
 * **v4 reads its own config rather than assuming paths.** `.bmad-core/core-config.yml`
 * is the file that tells BMAD's own agents where documents live, including
 * whether the PRD is sharded and under what pattern. A parser that hardcoded
 * `docs/prd.md` would silently import nothing from any project that moved or
 * sharded it — and sharding is a supported, common configuration.
 *
 * **Lowest round-trip fidelity of the four, structurally.** The v4→v6 break and
 * the story-capsule format varying across it are a ceiling, not a gap a better
 * parser closes. Story internals are best-effort by design: `.research/10 §2.4`
 * records that they were characterised rather than confirmed by direct fetch,
 * and re-checking the cited page while building this found the directory tree it
 * verified is **no longer present there** — so the v6 layout below is
 * as-verified-then, and a real v6 repo should be walked before anyone claims
 * high fidelity for it.
 *
 * **`baseline_commit` is a drift signal, carried not checked.** A story pinned
 * to a commit that no longer exists in the target repo is planned against a tree
 * that is gone. This parser records it; the check belongs at import time, where
 * git is reachable — a parser shelling out to git would make every dialect
 * depend on a repository being present to read files.
 */

const V6_OUTPUT = '_bmad-output';
const V6_CONFIG = '_bmad';
const V4_CORE = '.bmad-core';

const sha = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

const exists = (target: string): Promise<boolean> =>
  fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

/** `[Source: docs/architecture.md#Data-Model]` — BMAD's inline provenance. */
const SOURCE_CITATION = /\[Source:\s*([^\]]+)\]/g;

export interface StoryCapsule {
  readonly title: string;
  readonly body: string;
  /** Paths the story cites as its grounding — BMAD's Dev Notes convention. */
  readonly citations: readonly string[];
  /** The commit the story was planned against, if it pinned one. */
  readonly baselineCommit?: string | undefined;
  /** Files the story's edit contract says may be touched. */
  readonly editContract: readonly string[];
}

/**
 * Reads one story capsule.
 *
 * The citations are the part worth the effort: BMAD stories carry
 * `[Source: path#Section]` inline, which is a provenance trail most formats do
 * not have. Dropping it would turn grounded prose into an assertion, and the
 * reader would have no way to tell which it was.
 */
export function parseStoryCapsule(markdown: string, fallbackTitle: string): StoryCapsule {
  const title = /^#\s+(.+?)\s*$/m.exec(markdown)?.[1]?.trim() ?? fallbackTitle;
  const citations = [
    ...new Set([...markdown.matchAll(SOURCE_CITATION)].map((m) => (m[1] ?? '').trim())),
  ];
  const baselineCommit = /baseline_commit:\s*["']?([0-9a-f]{7,40})["']?/i.exec(markdown)?.[1];

  // "only modify these files" — the strict edit contract. Read as a list under
  // whatever heading names it, because the wording varies across releases.
  const contractBlock =
    /(?:only modify|files? to modify|edit contract)[^\n]*\n((?:\s*[-*][^\n]*\n?)+)/i.exec(
      markdown,
    )?.[1];
  const editContract =
    contractBlock === undefined
      ? []
      : contractBlock
          .split(/\r?\n/)
          .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
          .filter((entry): entry is string => entry !== undefined && entry !== '');

  return {
    title,
    body: markdown.trim(),
    citations,
    ...(baselineCommit === undefined ? {} : { baselineCommit }),
    editContract,
  };
}

/** `sprint-status.yaml` — BMAD's flat machine-readable state tracker. */
export function parseSprintStatus(yamlText: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    // A malformed status file costs status hints, not the import.
    return out;
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const id = record['id'] ?? record['story'] ?? record['name'];
          const status = record['status'];
          if (typeof id === 'string' && typeof status === 'string') out.set(id, status);
        }
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'string') out.set(key, entry);
        else visit(entry);
      }
    }
  };
  visit(parsed);
  return out;
}

interface Reader {
  (file: string): Promise<string | null>;
}

function makeReader(rootPath: string, warnings: ParseWarning[], skippedFiles: string[]): Reader {
  return async (file: string) => {
    const relative = path.relative(rootPath, file).replace(/\\/g, '/');
    try {
      return await fs.readFile(file, 'utf8');
    } catch (cause) {
      warnings.push({ file: relative, message: `unreadable: ${String(cause)}` });
      skippedFiles.push(relative);
      return null;
    }
  };
}

function storyNode(
  toolId: string,
  sourcePath: string,
  capsule: StoryCapsule,
  parentKey: string | undefined,
  status: string | undefined,
): IrNode {
  return IrNodeSchema.parse({
    kind: 'story',
    title: capsule.title,
    body: capsule.body,
    frontmatterHints: {
      // Every one of these is the source's claim, carried as such. `status:
      // done` in someone's sprint file is not evidence that anything passed.
      ...(status === undefined ? {} : { source_status: status }),
      ...(capsule.baselineCommit === undefined
        ? {}
        : {
            baseline_commit: capsule.baselineCommit,
            // Flagged for the import stage, which has git and can tell whether
            // this commit is still in the target repo's history.
            baseline_commit_unverified: true,
          }),
      ...(capsule.citations.length === 0 ? {} : { source_citations: capsule.citations }),
      ...(capsule.editContract.length === 0 ? {} : { file_ownership: capsule.editContract }),
    },
    externalRef: {
      source_tool: toolId,
      source_path: sourcePath,
      source_id_or_hash: sha(sourcePath),
    },
    preservedIdentifiers: [path.basename(sourcePath, '.md')],
    relations: parentKey === undefined ? [] : [{ type: 'parent', targetExternalRef: parentKey }],
  });
}

/** Walks a directory of `.md` files, one level deep, in a stable order. */
async function markdownIn(dir: string): Promise<readonly string[]> {
  return (await readDirSafe(dir)).filter((name) => name.endsWith('.md')).sort();
}

/* ------------------------------------------------------------------ */
/* v6 — `_bmad-output/`                                                */
/* ------------------------------------------------------------------ */

export class BmadV6Parser implements ToolParser {
  readonly toolId = 'bmad';
  readonly dialect = 'v6';

  async detect(rootPath: string): Promise<DetectionResult> {
    const output = path.join(rootPath, V6_OUTPUT);
    if (!(await exists(output))) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [`no ${V6_OUTPUT}/ directory`],
      };
    }

    const evidence = [`${V6_OUTPUT}/ exists`];
    let markers = 0;
    for (const marker of ['planning-artifacts', 'implementation-artifacts', 'project-context.md']) {
      if (await exists(path.join(output, marker))) {
        markers += 1;
        evidence.push(`${V6_OUTPUT}/${marker} exists`);
      }
    }
    if (await exists(path.join(rootPath, V6_CONFIG))) evidence.push(`${V6_CONFIG}/ exists`);

    // `_bmad-output/` is BMAD v6's own name and nothing else's, so the marker
    // alone is meaningful; its inner layout is what raises confidence.
    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      confidence: markers >= 2 ? 'high' : markers === 1 ? 'medium' : 'low',
      evidence,
    };
  }

  async parse(rootPath: string): Promise<ParseResult> {
    const warnings: ParseWarning[] = [];
    const skippedFiles: string[] = [];
    const read = makeReader(rootPath, warnings, skippedFiles);
    const items: IrNode[] = [];

    const output = path.join(rootPath, V6_OUTPUT);
    const planning = path.join(output, 'planning-artifacts');

    // project-context.md is auto-loaded by BMAD's own workflows — the closest
    // thing v6 has to a constitution.
    const contextFile = path.join(output, 'project-context.md');
    if (await exists(contextFile)) {
      const text = await read(contextFile);
      if (text !== null) {
        items.push(
          IrNodeSchema.parse({
            kind: 'constitution',
            title: 'Project context',
            body: text.trim(),
            externalRef: {
              source_tool: this.toolId,
              source_path: `${V6_OUTPUT}/project-context.md`,
              source_id_or_hash: 'project-context',
            },
          }),
        );
      }
    }

    for (const doc of ['prd.md', 'architecture.md', 'addendum.md']) {
      const full = path.join(planning, doc);
      if (!(await exists(full))) continue;
      const text = await read(full);
      if (text === null) continue;
      items.push(
        IrNodeSchema.parse({
          kind: 'spec',
          title: doc.replace(/\.md$/, ''),
          body: text.trim(),
          externalRef: {
            source_tool: this.toolId,
            source_path: `${V6_OUTPUT}/planning-artifacts/${doc}`,
            source_id_or_hash: doc,
          },
        }),
      );
    }

    const statusFile = path.join(output, 'implementation-artifacts', 'sprint-status.yaml');
    const statusText = (await exists(statusFile)) ? await read(statusFile) : null;
    const status = statusText === null ? new Map<string, string>() : parseSprintStatus(statusText);

    items.push(...(await this.#parseEpics(path.join(planning, 'epics'), status, read)));

    if (items.length === 0) {
      warnings.push({
        file: V6_OUTPUT,
        message: 'no BMAD v6 content found — nothing was imported',
      });
    }
    return { items, warnings, skippedFiles };
  }

  async #parseEpics(
    epicsDir: string,
    status: ReadonlyMap<string, string>,
    read: Reader,
  ): Promise<readonly IrNode[]> {
    const items: IrNode[] = [];

    for (const entry of (await readDirSafe(epicsDir)).sort()) {
      const full = path.join(epicsDir, entry);
      const isDir = await fs
        .stat(full)
        .then((s) => s.isDirectory())
        .catch(() => false);

      if (!isDir) {
        if (!entry.endsWith('.md')) continue;
        const text = await read(full);
        if (text === null) continue;
        // A flat epic file with no story folder: still an epic, and its stories
        // may simply live elsewhere. Importing it as a story would flatten a
        // level the source deliberately has.
        const relative = `${V6_OUTPUT}/planning-artifacts/epics/${entry}`;
        items.push(
          IrNodeSchema.parse({
            kind: 'epic',
            title: entry.replace(/\.md$/, ''),
            body: text.trim(),
            externalRef: {
              source_tool: this.toolId,
              source_path: relative,
              source_id_or_hash: sha(relative),
            },
            preservedIdentifiers: [entry.replace(/\.md$/, '')],
          }),
        );
        continue;
      }

      const epicRelative = `${V6_OUTPUT}/planning-artifacts/epics/${entry}`;
      const epicRef = {
        source_tool: this.toolId,
        source_path: epicRelative,
        source_id_or_hash: entry,
      };
      const epicKey = externalRefKey(epicRef);
      items.push(
        IrNodeSchema.parse({
          kind: 'epic',
          title: entry,
          body: '',
          externalRef: epicRef,
          preservedIdentifiers: [entry],
        }),
      );

      for (const storyFile of await markdownIn(full)) {
        const text = await read(path.join(full, storyFile));
        if (text === null) continue;
        const relative = `${epicRelative}/${storyFile}`;
        const capsule = parseStoryCapsule(text, storyFile.replace(/\.md$/, ''));
        items.push(
          storyNode(
            this.toolId,
            relative,
            capsule,
            epicKey,
            status.get(storyFile.replace(/\.md$/, '')),
          ),
        );
      }
    }
    return items;
  }
}

/* ------------------------------------------------------------------ */
/* v4 — `.bmad-core/core-config.yml` driven                            */
/* ------------------------------------------------------------------ */

export interface V4Locations {
  readonly prd: string;
  readonly architecture: string;
  readonly stories: string;
  readonly epics: string;
  readonly prdSharded: boolean;
  readonly prdShardedLocation?: string | undefined;
}

/**
 * Resolves v4 document locations from `core-config.yml`, falling back to the
 * documented defaults.
 *
 * The config exists precisely so a project can move or shard its documents, and
 * BMAD's own agents read it to find them. Hardcoding `docs/prd.md` would import
 * nothing from any project that used the feature.
 */
export function resolveV4Locations(configText: string | null): V4Locations {
  let config: Record<string, unknown> = {};
  if (configText !== null) {
    try {
      const parsed: unknown = parseYaml(configText);
      if (parsed !== null && typeof parsed === 'object') config = parsed as Record<string, unknown>;
    } catch {
      // A malformed config falls back to defaults rather than failing the
      // import — the documents are usually still where BMAD first put them.
    }
  }
  const str = (key: string, fallback: string): string => {
    const value = config[key];
    return typeof value === 'string' ? value : fallback;
  };

  const rawShardedLocation = config['prdShardedLocation'];
  const shardedLocation = typeof rawShardedLocation === 'string' ? rawShardedLocation : undefined;

  return {
    prd: str('prd', 'docs/prd.md'),
    architecture: str('architecture', 'docs/architecture.md'),
    stories: str('devStoryLocation', 'docs/stories'),
    epics: str('epicLocation', 'docs/epics'),
    prdSharded: config['prdSharded'] === true,
    ...(shardedLocation === undefined ? {} : { prdShardedLocation: shardedLocation }),
  };
}

export class BmadV4Parser implements ToolParser {
  readonly toolId = 'bmad';
  readonly dialect = 'v4';

  async detect(rootPath: string): Promise<DetectionResult> {
    const core = path.join(rootPath, V4_CORE);
    const hasCore = await exists(core);
    // A v6 project is not a v4 project. Sniffing on layout rather than on a
    // version string is the whole point: BMAD stamps no readable version into
    // its artifacts, so a v6 tree must be excluded by its own marker.
    const isV6 = await exists(path.join(rootPath, V6_OUTPUT));

    if (!hasCore || isV6) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [
          isV6 ? `${V6_OUTPUT}/ present — this is v6, not v4` : `no ${V4_CORE}/ directory`,
        ],
      };
    }

    const evidence = [`${V4_CORE}/ exists`];
    const hasConfig = await exists(path.join(core, 'core-config.yml'));
    if (hasConfig) evidence.push(`${V4_CORE}/core-config.yml exists`);

    const locations = resolveV4Locations(
      hasConfig
        ? await fs.readFile(path.join(core, 'core-config.yml'), 'utf8').catch(() => null)
        : null,
    );
    let found = 0;
    for (const [label, target] of [
      ['prd', locations.prd],
      ['architecture', locations.architecture],
      ['stories', locations.stories],
    ] as const) {
      if (await exists(path.join(rootPath, target))) {
        found += 1;
        evidence.push(`${label} at ${target}`);
      }
    }

    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      confidence: hasConfig && found >= 1 ? 'high' : found >= 1 ? 'medium' : 'low',
      evidence,
    };
  }

  async parse(rootPath: string): Promise<ParseResult> {
    const warnings: ParseWarning[] = [];
    const skippedFiles: string[] = [];
    const read = makeReader(rootPath, warnings, skippedFiles);
    const items: IrNode[] = [];

    const configPath = path.join(rootPath, V4_CORE, 'core-config.yml');
    const locations = resolveV4Locations(
      (await exists(configPath)) ? await read(configPath) : null,
    );

    for (const [target, title] of [
      [locations.prd, 'prd'],
      [locations.architecture, 'architecture'],
    ] as const) {
      const full = path.join(rootPath, target);
      if (!(await exists(full))) continue;
      const text = await read(full);
      if (text === null) continue;
      items.push(
        IrNodeSchema.parse({
          kind: 'spec',
          title,
          body: text.trim(),
          externalRef: {
            source_tool: this.toolId,
            source_path: target,
            source_id_or_hash: title,
          },
        }),
      );
    }

    // A sharded PRD lives as many files under its own location. Reading only
    // `prd.md` would import a stub and silently drop the actual requirements.
    if (locations.prdSharded && locations.prdShardedLocation !== undefined) {
      const shardDir = path.join(rootPath, locations.prdShardedLocation);
      for (const shard of await markdownIn(shardDir)) {
        const text = await read(path.join(shardDir, shard));
        if (text === null) continue;
        const relative = `${locations.prdShardedLocation}/${shard}`;
        items.push(
          IrNodeSchema.parse({
            kind: 'spec',
            title: `prd: ${shard.replace(/\.md$/, '')}`,
            body: text.trim(),
            frontmatterHints: { sharded_from: 'prd' },
            externalRef: {
              source_tool: this.toolId,
              source_path: relative,
              source_id_or_hash: sha(relative),
            },
          }),
        );
      }
    }

    const epicKeys = new Map<string, string>();
    const epicsDir = path.join(rootPath, locations.epics);
    for (const epicFile of await markdownIn(epicsDir)) {
      const text = await read(path.join(epicsDir, epicFile));
      if (text === null) continue;
      const relative = `${locations.epics}/${epicFile}`;
      const stem = epicFile.replace(/\.md$/, '');
      const ref = {
        source_tool: this.toolId,
        source_path: relative,
        source_id_or_hash: stem,
      };
      epicKeys.set(stem, externalRefKey(ref));
      items.push(
        IrNodeSchema.parse({
          kind: 'epic',
          title: stem,
          body: text.trim(),
          externalRef: ref,
          preservedIdentifiers: [stem],
        }),
      );
    }

    const storiesDir = path.join(rootPath, locations.stories);
    for (const storyFile of await markdownIn(storiesDir)) {
      const text = await read(path.join(storiesDir, storyFile));
      if (text === null) continue;
      const relative = `${locations.stories}/${storyFile}`;
      const capsule = parseStoryCapsule(text, storyFile.replace(/\.md$/, ''));
      // v4 stories are named `<epic>.<story>.<slug>.md`, so the epic is the
      // leading segment. Matched against epics we actually imported rather than
      // asserted, so a story naming an epic that is not here dangles visibly.
      const epicStem = [...epicKeys.keys()].find(
        (stem) =>
          storyFile.startsWith(`${stem.replace(/^epic-?/, '')}.`) ||
          storyFile.startsWith(`${stem}.`),
      );
      items.push(
        storyNode(
          this.toolId,
          relative,
          capsule,
          epicStem === undefined ? undefined : epicKeys.get(epicStem),
          undefined,
        ),
      );
    }

    if (items.length === 0) {
      warnings.push({ file: V4_CORE, message: 'no BMAD v4 content found — nothing was imported' });
    }
    return { items, warnings, skippedFiles };
  }
}

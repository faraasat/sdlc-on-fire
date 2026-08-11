import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { externalRefKey, IrNodeSchema, type IrNode } from './ir.js';
import type { DetectionResult, ParseResult, ParseWarning, ToolParser } from './port.js';

/**
 * The GSD parsers (P2-IMP-04, `.research/10 §2.1`).
 *
 * **Two shapes on disk, not three.** GSD is three living lineages — classic v1,
 * the community `gsd-core` continuation, and GSD-2 — but classic and gsd-core
 * are *near-identical on disk*, both rooted at `.planning/`, and none of the
 * projects reliably self-identify inside their own artifacts. So one parser
 * covers both, and it does not pretend to tell them apart: a dialect label
 * asserting "this is gsd-core, not classic" would be inventing a signal that
 * does not exist in the files, and every downstream decision made on it would
 * rest on a guess.
 *
 * GSD-2 is structurally different (`.gsd/`, milestone → slice → task, three
 * levels against the other's two) and gets its own parser — which **flattens to
 * the `.planning/` shape first and then reuses this file's node builders**,
 * exactly as GSD's own `/gsd-import --from-gsd2` reverse-migration does. Writing
 * a separate GSD-2 → IR path would mean two implementations of the same mapping
 * drifting apart, and GSD-2 is already deprecated in favour of GSD Pi, so it is
 * the one dialect least worth paying twice for.
 *
 * **The XML task block is the prize.** `<verify>` and `<done>` inside a plan map
 * essentially 1:1 onto our own task schema's verify command and acceptance
 * criteria — richer than anything the other three source formats carry, and the
 * reason `.research/05 §8` calls GSD the highest-fidelity task import.
 */

const PLANNING_DIR = '.planning';
const GSD2_DIR = '.gsd';

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

/** `REQ-001` — GSD's requirement identifier, cited in commits like Spec Kit's. */
const REQ_IDENTIFIER = /\bREQ-\d+\b/g;

export interface GsdTask {
  readonly name: string;
  readonly files?: string | undefined;
  readonly action?: string | undefined;
  /** The command GSD says proves this task — our `verify:`, almost verbatim. */
  readonly verify?: string | undefined;
  /** Success criteria — our acceptance criteria. */
  readonly done?: string | undefined;
  readonly type?: string | undefined;
}

const TASK_BLOCK = /<task\b([^>]*)>([\s\S]*?)<\/task>/g;
const tag = (body: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
  return match?.[1]?.trim();
};

/**
 * Reads the XML task blocks out of a plan.
 *
 * Deliberately regex-based rather than a real XML parse: these blocks live
 * inside Markdown, are frequently not well-formed as a document, and a strict
 * parser would reject a whole plan over one unescaped `&` in a shell command.
 * The failure mode that matters here is losing a task, not mis-reading one.
 */
export function parseTaskBlocks(markdown: string): readonly GsdTask[] {
  const out: GsdTask[] = [];
  for (const match of markdown.matchAll(TASK_BLOCK)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const name = tag(body, 'name');
    if (name === undefined || name === '') continue;

    const type = /type\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    out.push({
      name,
      ...(tag(body, 'files') === undefined ? {} : { files: tag(body, 'files') }),
      ...(tag(body, 'action') === undefined ? {} : { action: tag(body, 'action') }),
      ...(tag(body, 'verify') === undefined ? {} : { verify: tag(body, 'verify') }),
      ...(tag(body, 'done') === undefined ? {} : { done: tag(body, 'done') }),
      ...(type === undefined ? {} : { type }),
    });
  }
  return out;
}

/** `- [x] 01 Foundation` — the roadmap's phase-status markers. */
const ROADMAP_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/;

export function parseRoadmap(markdown: string): readonly { title: string; done: boolean }[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => ROADMAP_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      title: (match[2] ?? '').trim(),
      done: (match[1] ?? ' ').toLowerCase() === 'x',
    }));
}

/**
 * A phase's plan files, wherever the release put them.
 *
 * Newer classic releases nest plans under `plans/<N>-PLAN-<NN>-<slug>.md`
 * instead of a flat `NN-NN-PLAN.md`, and a phase folder may carry a
 * `project_code` prefix (`XR-02.1-spike/` beside plain `01-foundation/`). Both
 * are release wrinkles rather than dialects, so they are tolerated here rather
 * than sniffed as a separate lineage.
 */
async function planFilesIn(phaseDir: string): Promise<readonly string[]> {
  const flat = (await readDirSafe(phaseDir)).filter((name) => /PLAN.*\.md$/i.test(name));
  const nested = (await readDirSafe(path.join(phaseDir, 'plans')))
    .filter((name) => /PLAN.*\.md$/i.test(name))
    .map((name) => path.join('plans', name));
  return [...flat, ...nested].sort();
}

/** Where phases live — flat, or archived under a milestone folder. */
async function phaseRootsIn(planningDir: string): Promise<readonly string[]> {
  const roots: string[] = [];
  if (await exists(path.join(planningDir, 'phases'))) roots.push(path.join(planningDir, 'phases'));
  for (const entry of await readDirSafe(path.join(planningDir, 'milestones'))) {
    // `milestones/v1.2-phases/` — the milestone-archive layout.
    if (/-phases$/.test(entry)) roots.push(path.join(planningDir, 'milestones', entry));
  }
  return roots;
}

interface BuildContext {
  readonly toolId: string;
  readonly dialect: string;
  /** Path prefix recorded in external refs — the *source* path, not our layout. */
  readonly sourcePrefix: string;
  readonly warn: (warning: ParseWarning) => void;
}

function docNode(
  ctx: BuildContext,
  kind: 'constitution' | 'spec',
  title: string,
  body: string,
  relPath: string,
): IrNode {
  return IrNodeSchema.parse({
    kind,
    title,
    body: body.trim(),
    externalRef: {
      source_tool: ctx.toolId,
      source_path: relPath,
      source_id_or_hash: sha(relPath),
    },
    preservedIdentifiers: [...new Set(body.match(REQ_IDENTIFIER) ?? [])],
  });
}

/**
 * Builds the IR for one `.planning/`-shaped tree.
 *
 * Shared by both dialects: GSD-2 flattens into this shape before calling it, so
 * there is exactly one mapping from GSD concepts onto ours.
 */
async function buildFromPlanning(
  planningDir: string,
  ctx: BuildContext,
  read: (file: string) => Promise<string | null>,
): Promise<readonly IrNode[]> {
  const items: IrNode[] = [];

  // PROJECT.md is GSD's always-loaded vision/constraints document — the closest
  // thing it has to a constitution.
  for (const [file, kind, title] of [
    ['PROJECT.md', 'constitution', 'Project'],
    ['REQUIREMENTS.md', 'spec', 'Requirements'],
    ['STATE.md', 'spec', 'State'],
  ] as const) {
    const full = path.join(planningDir, file);
    if (!(await exists(full))) continue;
    const text = await read(full);
    if (text === null) continue;
    items.push(docNode(ctx, kind, title, text, `${ctx.sourcePrefix}/${file}`));
  }

  const roadmapPath = path.join(planningDir, 'ROADMAP.md');
  const roadmapText = (await exists(roadmapPath)) ? await read(roadmapPath) : null;
  const roadmapStatus = new Map(
    (roadmapText === null ? [] : parseRoadmap(roadmapText)).map((entry) => [
      entry.title,
      entry.done,
    ]),
  );

  for (const phaseRoot of await phaseRootsIn(planningDir)) {
    for (const phaseName of (await readDirSafe(phaseRoot)).sort()) {
      const phaseDir = path.join(phaseRoot, phaseName);
      if (
        !(await fs
          .stat(phaseDir)
          .then((s) => s.isDirectory())
          .catch(() => false))
      )
        continue;

      const phaseRelative = `${ctx.sourcePrefix}/${path.relative(planningDir, phaseDir).replace(/\\/g, '/')}`;
      const phaseRef = {
        source_tool: ctx.toolId,
        source_path: phaseRelative,
        source_id_or_hash: phaseName,
      };
      const phaseKey = externalRefKey(phaseRef);

      const context = await read(path.join(phaseDir, 'CONTEXT.md')).catch(() => null);
      items.push(
        IrNodeSchema.parse({
          kind: 'story',
          title: phaseName,
          body: context ?? '',
          frontmatterHints: {
            phase: phaseName,
            // From the roadmap's own checkbox, carried as a hint. Even GSD's
            // status marker is somebody's claim until a gate says otherwise.
            ...(roadmapStatus.has(phaseName)
              ? { source_checked: roadmapStatus.get(phaseName) }
              : {}),
          },
          externalRef: phaseRef,
          preservedIdentifiers: [phaseName],
        }),
      );

      for (const planFile of await planFilesIn(phaseDir)) {
        const full = path.join(phaseDir, planFile);
        const text = await read(full);
        if (text === null) continue;

        const planRelative = `${phaseRelative}/${planFile.replace(/\\/g, '/')}`;
        // A sibling SUMMARY is GSD's "this ran" marker. A hint, never a
        // lifecycle state: the whole point of this product is that finished is
        // something evidence says, not something a filename says.
        //
        // Renamed on the **basename only**. Replacing on the full path matched
        // the `plan` inside `.planning/` first — case-insensitively, that
        // directory contains the very word — and produced a path in a directory
        // that does not exist, so no plan ever looked executed.
        const summary = path.join(
          path.dirname(full),
          path.basename(full).replace(/PLAN(.*)\.md$/i, 'SUMMARY$1.md'),
        );
        const executed = await exists(summary);

        const tasks = parseTaskBlocks(text);
        if (tasks.length === 0) {
          ctx.warn({
            file: planRelative,
            message: 'no <task> blocks found — imported as a plan document only',
          });
          items.push(
            IrNodeSchema.parse({
              kind: 'spec',
              title: `${phaseName}: ${path.basename(planFile)}`,
              body: text.trim(),
              frontmatterHints: { phase: phaseName, source_executed: executed },
              externalRef: {
                source_tool: ctx.toolId,
                source_path: planRelative,
                source_id_or_hash: sha(planRelative),
              },
              relations: [{ type: 'parent', targetExternalRef: phaseKey }],
            }),
          );
          continue;
        }

        for (const [index, task] of tasks.entries()) {
          items.push(
            IrNodeSchema.parse({
              kind: 'task',
              title: task.name,
              body: [
                task.action === undefined ? '' : task.action,
                task.done === undefined ? '' : `\n\n## Done when\n\n${task.done}`,
              ]
                .join('')
                .trim(),
              frontmatterHints: {
                phase: phaseName,
                source_executed: executed,
                // `<verify>` is the richest thing GSD carries: a real command,
                // which is exactly what our own gate needs and what the other
                // three source formats cannot supply.
                ...(task.verify === undefined ? {} : { verify: task.verify }),
                ...(task.done === undefined ? {} : { done_criteria: task.done }),
                ...(task.files === undefined ? {} : { file_ownership: task.files }),
                ...(task.type === undefined ? {} : { task_type: task.type }),
              },
              externalRef: {
                source_tool: ctx.toolId,
                source_path: planRelative,
                source_id_or_hash: sha(`${planRelative}#${String(index)}#${task.name}`),
              },
              relations: [{ type: 'parent', targetExternalRef: phaseKey }],
            }),
          );
        }
      }
    }
  }

  return items;
}

function makeReader(
  rootPath: string,
  warnings: ParseWarning[],
  skippedFiles: string[],
): (file: string) => Promise<string | null> {
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

/** Classic v1 and the community `gsd-core` continuation — one shape, one parser. */
export class GsdPlanningParser implements ToolParser {
  readonly toolId = 'gsd';
  readonly dialect = 'planning';

  async detect(rootPath: string): Promise<DetectionResult> {
    const base = path.join(rootPath, PLANNING_DIR);
    if (!(await exists(base))) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [`no ${PLANNING_DIR}/ directory`],
      };
    }

    const evidence = [`${PLANNING_DIR}/ exists`];
    let markers = 0;
    for (const marker of ['PROJECT.md', 'ROADMAP.md', 'REQUIREMENTS.md', 'STATE.md']) {
      if (await exists(path.join(base, marker))) {
        markers += 1;
        evidence.push(`${PLANNING_DIR}/${marker} exists`);
      }
    }
    const hasPhases = (await phaseRootsIn(base)).length > 0;
    if (hasPhases) evidence.push(`${PLANNING_DIR}/ has a phases tree`);

    // `.planning/` is distinctive, but a lone empty one proves little. Two or
    // more of GSD's own top-level documents, or a phases tree, is a real match.
    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      confidence: markers >= 2 || hasPhases ? 'high' : markers === 1 ? 'medium' : 'low',
      evidence,
    };
  }

  async parse(rootPath: string): Promise<ParseResult> {
    const warnings: ParseWarning[] = [];
    const skippedFiles: string[] = [];
    const items = await buildFromPlanning(
      path.join(rootPath, PLANNING_DIR),
      {
        toolId: this.toolId,
        dialect: this.dialect,
        sourcePrefix: PLANNING_DIR,
        warn: (warning) => warnings.push(warning),
      },
      makeReader(rootPath, warnings, skippedFiles),
    );
    if (items.length === 0) {
      warnings.push({ file: PLANNING_DIR, message: 'no GSD content found — nothing was imported' });
    }
    return { items, warnings, skippedFiles };
  }
}

/** One GSD-2 slice, flattened onto the phase the v1 mapping gives it. */
export interface FlattenedSlice {
  readonly milestone: string;
  readonly slice: string;
  /** `phases/<NN>-<slug>/` — slices renumbered sequentially across milestones. */
  readonly phaseName: string;
  readonly sliceDir: string;
}

/**
 * The documented GSD-2 → v1 mapping, applied to a `.gsd/` tree.
 *
 * Slices renumber **sequentially across all milestones**, which is the one part
 * of this mapping that cannot be done per-milestone: M002's first slice is
 * phase 3 if M001 had two. Reproducing GSD's own reverse-migration rather than
 * inventing a numbering keeps an imported tree comparable to one a user could
 * have produced with `/gsd-import --from-gsd2` themselves.
 */
export async function flattenGsd2(gsdDir: string): Promise<readonly FlattenedSlice[]> {
  const out: FlattenedSlice[] = [];
  let ordinal = 0;

  for (const milestone of (await readDirSafe(path.join(gsdDir, 'milestones'))).sort()) {
    const slicesDir = path.join(gsdDir, 'milestones', milestone, 'slices');
    for (const slice of (await readDirSafe(slicesDir)).sort()) {
      const sliceDir = path.join(slicesDir, slice);
      if (
        !(await fs
          .stat(sliceDir)
          .then((s) => s.isDirectory())
          .catch(() => false))
      )
        continue;
      ordinal += 1;
      out.push({
        milestone,
        slice,
        phaseName: `${String(ordinal).padStart(2, '0')}-${milestone.toLowerCase()}-${slice.toLowerCase()}`,
        sliceDir,
      });
    }
  }
  return out;
}

/**
 * GSD-2 / redux — legacy only.
 *
 * The upstream repo is itself deprecated in favour of GSD Pi, so this dialect
 * exists to get people *off* it. It flattens to the `.planning/` shape and hands
 * off to the shared builders rather than carrying a second mapping.
 */
export class Gsd2Parser implements ToolParser {
  readonly toolId = 'gsd';
  readonly dialect = 'gsd2';

  async detect(rootPath: string): Promise<DetectionResult> {
    const base = path.join(rootPath, GSD2_DIR);
    if (!(await exists(path.join(base, 'milestones')))) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [`no ${GSD2_DIR}/milestones/ directory`],
      };
    }

    const evidence = [`${GSD2_DIR}/milestones/ exists`];
    const slices = await flattenGsd2(base);
    if (slices.length > 0) {
      evidence.push(
        `${String(slices.length)} slice(s) across ${String(
          new Set(slices.map((s) => s.milestone)).size,
        )} milestone(s)`,
      );
    }
    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      // The milestone → slice → task nesting is unique to GSD-2; nothing else
      // produces it, so finding real slices is conclusive.
      confidence: slices.length > 0 ? 'high' : 'medium',
      evidence,
    };
  }

  async parse(rootPath: string): Promise<ParseResult> {
    const warnings: ParseWarning[] = [];
    const skippedFiles: string[] = [];
    const read = makeReader(rootPath, warnings, skippedFiles);
    const base = path.join(rootPath, GSD2_DIR);
    const items: IrNode[] = [];

    for (const flat of await flattenGsd2(base)) {
      const sourcePrefix = `${GSD2_DIR}/milestones/${flat.milestone}/slices/${flat.slice}`;
      const phaseRef = {
        source_tool: this.toolId,
        source_path: sourcePrefix,
        source_id_or_hash: `${flat.milestone}/${flat.slice}`,
      };
      const phaseKey = externalRefKey(phaseRef);

      const research = await read(path.join(flat.sliceDir, `${flat.slice}-RESEARCH.md`)).catch(
        () => null,
      );
      items.push(
        IrNodeSchema.parse({
          kind: 'story',
          title: flat.phaseName,
          body: research ?? '',
          frontmatterHints: {
            milestone: flat.milestone,
            slice: flat.slice,
            // The v1 phase name this slice maps onto, so an importer's output
            // is comparable to what `/gsd-import --from-gsd2` would produce.
            mapped_phase: flat.phaseName,
          },
          externalRef: phaseRef,
          preservedIdentifiers: [flat.milestone, flat.slice],
        }),
      );

      const tasksDir = path.join(flat.sliceDir, 'tasks');
      for (const taskFile of (await readDirSafe(tasksDir)).filter((n) => /PLAN\.md$/i.test(n))) {
        const text = await read(path.join(tasksDir, taskFile));
        if (text === null) continue;
        const planRelative = `${sourcePrefix}/tasks/${taskFile}`;
        const executed = await exists(
          path.join(tasksDir, taskFile.replace(/PLAN\.md$/i, 'SUMMARY.md')),
        );

        for (const [index, task] of parseTaskBlocks(text).entries()) {
          items.push(
            IrNodeSchema.parse({
              kind: 'task',
              title: task.name,
              body: task.action ?? '',
              frontmatterHints: {
                milestone: flat.milestone,
                slice: flat.slice,
                source_executed: executed,
                ...(task.verify === undefined ? {} : { verify: task.verify }),
                ...(task.done === undefined ? {} : { done_criteria: task.done }),
              },
              externalRef: {
                source_tool: this.toolId,
                source_path: planRelative,
                source_id_or_hash: sha(`${planRelative}#${String(index)}#${task.name}`),
              },
              relations: [{ type: 'parent', targetExternalRef: phaseKey }],
            }),
          );
        }
      }
    }

    if (items.length === 0) {
      warnings.push({ file: GSD2_DIR, message: 'no GSD-2 content found — nothing was imported' });
    }
    return { items, warnings, skippedFiles };
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { externalRefKey, IrNodeSchema, type IrNode } from './ir.js';
import type { DetectionResult, ParseResult, ParseWarning, ToolParser } from './port.js';

/**
 * The Spec Kit parser (P2-IMP-05, `.research/10 §2.2`).
 *
 * **Identifiers are the whole job here.** `FR-003`, `SC-001`, `P1` — teams cite
 * these in commits, PRs and standups, so an import that renumbers them breaks
 * every one of those references, and the breakage shows up as a human
 * misreading a PR rather than as an error anything catches. They are lifted out
 * verbatim and carried as `preservedIdentifiers` *and* as the external-ref id,
 * which also makes re-import stable across a source edit that reorders sections.
 *
 * **There is no change history to import, and that is structural.** Spec Kit's
 * `converge` is append-only rather than diff-aware: it can add gap-fill tasks
 * but cannot express "this requirement changed". So a Spec Kit repo offers a
 * flat current-state snapshot and nothing more. Moderate fidelity here is a
 * ceiling of the source format, not something a better parser could lift — and
 * saying so is more useful than quietly importing less than the user expects.
 *
 * **`[NEEDS CLARIFICATION]` is carried, not resolved.** It marks a question the
 * source team has not answered; an importer that dropped the marker would turn
 * an open question into settled prose, which is the one transformation nobody
 * asked for.
 */

const SPECS_DIR = 'specs';
const SPECIFY_DIR = '.specify';

const sha = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);

const relPosix = (root: string, full: string): string =>
  path.relative(root, full).replace(/\\/g, '/');

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

/** `FR-003`, `SC-001` — the identifiers teams actually reference. */
const IDENTIFIER = /\b((?:FR|SC|NFR)-\d+)\b/g;
/** A user story's priority tier. */
const PRIORITY = /\b(P[123])\b/;
/** An unanswered question the source team left in place. */
const NEEDS_CLARIFICATION = /\[NEEDS CLARIFICATION[^\]]*\]/i;
/** `## `/`### ` section headers, which is how spec.md is organised. */
const HEADING = /^(#{2,4})\s+(.+?)\s*$/;

export interface SpecSection {
  readonly heading: string;
  readonly body: string;
  readonly identifiers: readonly string[];
  readonly priority?: string | undefined;
  readonly needsClarification: boolean;
}

/**
 * Splits a Spec Kit document into its sections, lifting the identifiers out.
 *
 * Section-level rather than line-level: an `FR-003` line is meaningless without
 * the paragraph under it, and Spec Kit puts the requirement text there.
 */
export function splitSections(markdown: string): readonly SpecSection[] {
  const lines = markdown.split(/\r?\n/);
  const out: SpecSection[] = [];
  let current: { heading: string; body: string[] } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const body = current.body.join('\n').trim();
    const scope = `${current.heading}\n${body}`;
    out.push({
      heading: current.heading,
      body,
      identifiers: [...new Set(scope.match(IDENTIFIER) ?? [])],
      ...(PRIORITY.exec(current.heading)?.[1] === undefined
        ? {}
        : { priority: PRIORITY.exec(current.heading)?.[1] }),
      needsClarification: NEEDS_CLARIFICATION.test(scope),
    });
    current = undefined;
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      current = { heading: heading[2] ?? '', body: [] };
      continue;
    }
    if (current !== undefined) current.body.push(line);
  }
  flush();
  return out.filter((section) => section.body !== '' || section.identifiers.length > 0);
}

/** `- [ ] T001 [P] [US1] do the thing` — Spec Kit's task list with its markers. */
const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/;

export interface SpecKitTask {
  readonly title: string;
  readonly done: boolean;
  /** `[P]` — safe to run in parallel with its neighbours. */
  readonly parallel: boolean;
  /** `[US1]` — which user story this task serves. */
  readonly story?: string | undefined;
}

export function splitTaskLines(markdown: string): readonly SpecKitTask[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => TASK_LINE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => {
      const raw = match[2] ?? '';
      const story = /\[(US\d+)\]/.exec(raw)?.[1];
      return {
        // The markers are stripped from the title and kept as structure —
        // leaving `[P]` in a card's title turns a machine marker into prose.
        title: raw
          .replace(/\[(P|US\d+)\]/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim(),
        done: (match[1] ?? ' ').toLowerCase() === 'x',
        parallel: /\[P\]/.test(raw),
        ...(story === undefined ? {} : { story }),
      };
    });
}

export class SpecKitParser implements ToolParser {
  readonly toolId = 'speckit';
  readonly dialect = 'v1';

  async detect(rootPath: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const hasSpecify = await exists(path.join(rootPath, SPECIFY_DIR));
    const hasSpecs = await exists(path.join(rootPath, SPECS_DIR));

    if (!hasSpecify && !hasSpecs) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [`neither ${SPECIFY_DIR}/ nor ${SPECS_DIR}/ present`],
      };
    }
    if (hasSpecify) evidence.push(`${SPECIFY_DIR}/ exists`);
    if (hasSpecs) evidence.push(`${SPECS_DIR}/ exists`);

    // `specs/` alone is far too common a directory name to claim on. The shape
    // sniff is Spec Kit's own identifier convention, which nothing else uses.
    let identifierSeen = false;
    for (const feature of await readDirSafe(path.join(rootPath, SPECS_DIR))) {
      const spec = path.join(rootPath, SPECS_DIR, feature, 'spec.md');
      const text = await fs.readFile(spec, 'utf8').catch(() => null);
      if (text !== null && /\b(?:FR|SC)-\d+\b/.test(text)) {
        identifierSeen = true;
        evidence.push(`${SPECS_DIR}/${feature}/spec.md uses FR-/SC- identifiers`);
        break;
      }
    }

    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      // `.specify/` is Spec Kit's own directory and nothing else's, so its
      // presence alone is strong. `specs/` without the identifiers is weak,
      // because half the repositories in the world have a `specs/` folder.
      confidence: identifierSeen || hasSpecify ? 'high' : 'low',
      evidence,
    };
  }

  async parse(rootPath: string): Promise<ParseResult> {
    const items: IrNode[] = [];
    const warnings: ParseWarning[] = [];
    const skippedFiles: string[] = [];

    const read = async (file: string): Promise<string | null> => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (cause) {
        warnings.push({ file: relPosix(rootPath, file), message: `unreadable: ${String(cause)}` });
        skippedFiles.push(relPosix(rootPath, file));
        return null;
      }
    };

    // The constitution, if the project has one. Spec Kit versions it with
    // SemVer and a Sync Impact Report; both ride along in the body rather than
    // being parsed into fields we would then have to keep in step.
    const constitution = path.join(rootPath, SPECIFY_DIR, 'memory', 'constitution.md');
    if (await exists(constitution)) {
      const text = await read(constitution);
      if (text !== null) {
        items.push(
          IrNodeSchema.parse({
            kind: 'constitution',
            title: 'Constitution',
            body: text.trim(),
            externalRef: {
              source_tool: this.toolId,
              source_path: `${SPECIFY_DIR}/memory/constitution.md`,
              source_id_or_hash: 'constitution',
            },
          }),
        );
      }
    }

    for (const feature of await readDirSafe(path.join(rootPath, SPECS_DIR))) {
      const featureDir = path.join(rootPath, SPECS_DIR, feature);
      const specFile = path.join(featureDir, 'spec.md');
      if (!(await exists(specFile))) continue;

      const featureRef = {
        source_tool: this.toolId,
        source_path: `${SPECS_DIR}/${feature}`,
        source_id_or_hash: feature,
      };
      const featureKey = externalRefKey(featureRef);

      const specText = await read(specFile);
      items.push(
        IrNodeSchema.parse({
          kind: 'story',
          title: feature,
          body: specText === null ? '' : specText.trim(),
          frontmatterHints: { feature },
          externalRef: featureRef,
          preservedIdentifiers: [feature],
        }),
      );

      // Sections carrying identifiers become specs in their own right, so an
      // `FR-003` remains individually addressable after the import.
      if (specText !== null) {
        for (const section of splitSections(specText)) {
          if (section.identifiers.length === 0) continue;
          items.push(
            IrNodeSchema.parse({
              kind: 'spec',
              title: `${feature}: ${section.heading}`,
              body: section.body,
              frontmatterHints: {
                feature,
                ...(section.priority === undefined ? {} : { priority: section.priority }),
                // Carried, never resolved: dropping the marker would turn an
                // open question into settled prose.
                ...(section.needsClarification ? { needs_clarification: true } : {}),
              },
              externalRef: {
                ...featureRef,
                source_path: `${SPECS_DIR}/${feature}/spec.md`,
                // Keyed on the identifier itself, so re-import stays stable when
                // the source reorders its sections.
                source_id_or_hash: section.identifiers.join(','),
              },
              preservedIdentifiers: section.identifiers,
              relations: [{ type: 'parent', targetExternalRef: featureKey }],
            }),
          );
        }
      }

      // `exists` first: `plan.md` and `tasks.md` are optional, and reporting an
      // absent optional file as "unreadable: ENOENT" turns a healthy import into
      // one that looks broken. A warning list is for defects, not for absences.
      const planFile = path.join(featureDir, 'plan.md');
      const plan = (await exists(planFile)) ? await read(planFile) : null;
      if (plan !== null) {
        items.push(
          IrNodeSchema.parse({
            kind: 'spec',
            title: `${feature}: plan`,
            body: plan.trim(),
            frontmatterHints: { feature, artifact: 'plan' },
            externalRef: {
              ...featureRef,
              source_path: `${SPECS_DIR}/${feature}/plan.md`,
              source_id_or_hash: sha(`${feature}#plan`),
            },
            relations: [{ type: 'parent', targetExternalRef: featureKey }],
          }),
        );
      }

      const tasksFile = path.join(featureDir, 'tasks.md');
      const tasks = (await exists(tasksFile)) ? await read(tasksFile) : null;
      if (tasks !== null) {
        for (const [index, task] of splitTaskLines(tasks).entries()) {
          items.push(
            IrNodeSchema.parse({
              kind: 'task',
              title: task.title,
              body: '',
              frontmatterHints: {
                feature,
                source_checked: task.done,
                parallel_safe: task.parallel,
                ...(task.story === undefined ? {} : { user_story: task.story }),
              },
              externalRef: {
                ...featureRef,
                source_path: `${SPECS_DIR}/${feature}/tasks.md`,
                source_id_or_hash: sha(`${feature}#${String(index)}#${task.title}`),
              },
              relations: [{ type: 'parent', targetExternalRef: featureKey }],
            }),
          );
        }
      }
    }

    if (items.length === 0) {
      warnings.push({
        file: SPECS_DIR,
        message: 'no Spec Kit features found — nothing was imported',
      });
    }
    return { items, warnings, skippedFiles };
  }
}

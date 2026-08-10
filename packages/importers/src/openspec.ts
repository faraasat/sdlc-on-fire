import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { externalRefKey, IrNodeSchema, type IrNode } from './ir.js';
import type { DetectionResult, ParseResult, ParseWarning, ToolParser } from './port.js';

/**
 * The OpenSpec parser (P2-IMP-03, `.research/10 §2.3`).
 *
 * **Highest fidelity, so it goes first.** OpenSpec writes RFC-2119 requirements
 * with GIVEN/WHEN/THEN scenarios, which is already our acceptance-criteria
 * format — the mapping is close to 1:1, so this parser exercises the framework
 * without a lossy translation muddying what it proves. It also has a single
 * stable lineage and no fork schism, unlike GSD and BMAD, so it is the one
 * dialect least likely to need rewriting mid-Phase-2.
 *
 * **Archived changes are history, not clutter.** `changes/archive/<date>-<id>/`
 * keeps the whole proposal + design + tasks + delta bundle rather than a
 * squashed final state, and it is the only source format among the four from
 * which real change *history* can be reconstructed. Dropping it on import
 * because it is "old" would throw away the one thing this format offers that
 * the others cannot.
 */

const OPENSPEC_DIR = 'openspec';

/**
 * The external-ref key of a change, built through `externalRefKey` rather than
 * by hand.
 *
 * Hand-assembling `openspec:<path>` omitted the id segment, so every relation
 * named a key the writer could not match and the whole hierarchy read as
 * dangling — an import that looks clean and arrives flat.
 */
const changeRefKey = (changeId: string): string =>
  externalRefKey({
    source_tool: 'openspec',
    source_path: `${OPENSPEC_DIR}/changes/${changeId}`,
    source_id_or_hash: changeId,
  });

const sha = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);

/** Posix-normalised, so an external ref is identical on Windows (ADR-0072). */
const relPosix = (root: string, full: string): string =>
  path.relative(root, full).replace(/\\/g, '/');

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** `### Requirement: <title>` — the unit OpenSpec organises a spec around. */
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/;
/**
 * The same pattern for whole-document sniffing.
 *
 * Separate because `^`/`$` without `m` anchor to the whole string, so testing a
 * multi-line document against the line-oriented pattern silently never matches —
 * which downgraded every real OpenSpec tree from `high` confidence to `medium`.
 */
const REQUIREMENT_ANYWHERE = /^###\s+Requirement:\s*.+$/m;
/** `## ADDED|MODIFIED|REMOVED|RENAMED Requirements` — a delta section header. */
const DELTA_SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;

export interface Requirement {
  readonly title: string;
  readonly body: string;
  /** Present only inside a change delta; absent in a current-state spec. */
  readonly delta?: 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | undefined;
}

/**
 * Splits a spec into its requirements, carrying any delta section down onto
 * each one.
 *
 * The delta verb lives on a `##` header above a run of `###` requirements, so a
 * parser that reads requirements alone loses the single most important fact
 * about a change file: whether a requirement is being added or deleted. Losing
 * it would turn a REMOVED requirement into a newly-imported one — the exact
 * inversion of what the source says.
 */
export function splitRequirements(markdown: string): readonly Requirement[] {
  const lines = markdown.split(/\r?\n/);
  const out: Requirement[] = [];
  let section: Requirement['delta'];
  let current: { title: string; body: string[] } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    out.push({
      title: current.title,
      body: current.body.join('\n').trim(),
      ...(section === undefined ? {} : { delta: section }),
    });
    current = undefined;
  };

  for (const line of lines) {
    const deltaHeader = DELTA_SECTION.exec(line);
    if (deltaHeader !== null) {
      flush();
      section = deltaHeader[1]?.toUpperCase() as Requirement['delta'];
      continue;
    }
    const requirement = REQUIREMENT.exec(line);
    if (requirement !== null) {
      flush();
      current = { title: requirement[1] ?? '', body: [] };
      continue;
    }
    if (current !== undefined) current.body.push(line);
  }
  flush();
  return out;
}

function specNode(
  root: string,
  file: string,
  domain: string,
  requirement: Requirement,
  changeId?: string,
): IrNode {
  const sourcePath = relPosix(root, file);
  const title =
    requirement.delta === undefined
      ? `${domain}: ${requirement.title}`
      : `${domain}: ${requirement.title} (${requirement.delta})`;

  return IrNodeSchema.parse({
    // A delta belongs to a change; a current-state requirement is a spec.
    kind: changeId === undefined ? 'spec' : 'change',
    title,
    body: requirement.body,
    frontmatterHints: {
      domain,
      ...(requirement.delta === undefined ? {} : { delta: requirement.delta }),
      ...(changeId === undefined ? {} : { change_id: changeId }),
    },
    externalRef: {
      source_tool: 'openspec',
      source_path: sourcePath,
      // OpenSpec requirements have no id of their own, so the title within its
      // file is the natural key — hashed with the path so two domains can each
      // have an "Authentication" requirement without colliding.
      source_id_or_hash: sha(`${sourcePath}#${requirement.title}`),
    },
    preservedIdentifiers: [requirement.title],
    relations:
      changeId === undefined
        ? []
        : [{ type: 'delta-of', targetExternalRef: changeRefKey(changeId) }],
  });
}

/** `- [ ] do the thing` / `- [x] done` — OpenSpec's implementation checklist. */
const CHECKLIST = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/;

export function splitTasks(markdown: string): readonly { title: string; done: boolean }[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => CHECKLIST.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ title: match[2] ?? '', done: (match[1] ?? ' ').toLowerCase() === 'x' }));
}

export class OpenSpecParser implements ToolParser {
  readonly toolId = 'openspec';
  readonly dialect = 'v1';

  /**
   * Marker directory plus a shape sniff.
   *
   * An `openspec/` directory says someone once ran OpenSpec; it does not say
   * the contents still parse as OpenSpec. Confidence separates the two, and a
   * low-confidence match is flagged for review rather than imported silently.
   */
  async detect(rootPath: string): Promise<DetectionResult> {
    const base = path.join(rootPath, OPENSPEC_DIR);
    const evidence: string[] = [];

    if (!(await exists(base))) {
      return {
        toolId: this.toolId,
        dialect: this.dialect,
        matched: false,
        confidence: 'low',
        evidence: [`no ${OPENSPEC_DIR}/ directory`],
      };
    }
    evidence.push(`${OPENSPEC_DIR}/ exists`);

    const hasSpecs = await exists(path.join(base, 'specs'));
    const hasChanges = await exists(path.join(base, 'changes'));
    if (hasSpecs) evidence.push(`${OPENSPEC_DIR}/specs/ exists`);
    if (hasChanges) evidence.push(`${OPENSPEC_DIR}/changes/ exists`);

    // The shape sniff: a real OpenSpec spec contains `### Requirement:`.
    // Without it the directory is a name, not a format.
    let requirementSeen = false;
    for (const domain of await readDirSafe(path.join(base, 'specs'))) {
      const spec = path.join(base, 'specs', domain, 'spec.md');
      const text = await fs.readFile(spec, 'utf8').catch(() => null);
      if (text !== null && REQUIREMENT_ANYWHERE.test(text)) {
        requirementSeen = true;
        evidence.push(`${OPENSPEC_DIR}/specs/${domain}/spec.md has "### Requirement:" headers`);
        break;
      }
    }

    return {
      toolId: this.toolId,
      dialect: this.dialect,
      matched: true,
      confidence: requirementSeen ? 'high' : hasSpecs || hasChanges ? 'medium' : 'low',
      evidence,
    };
  }

  /**
   * Best-effort by contract: one unreadable file is a warning, never an abort.
   *
   * A migration of four hundred files cannot be stopped by one of them, because
   * the person running it has no way to know which file did it and this parser
   * has every way to say so.
   */
  async parse(rootPath: string): Promise<ParseResult> {
    const base = path.join(rootPath, OPENSPEC_DIR);
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

    // 1. Current-state specs.
    for (const domain of await readDirSafe(path.join(base, 'specs'))) {
      const file = path.join(base, 'specs', domain, 'spec.md');
      if (!(await exists(file))) continue;
      const text = await read(file);
      if (text === null) continue;

      const requirements = splitRequirements(text);
      if (requirements.length === 0) {
        warnings.push({
          file: relPosix(rootPath, file),
          message: 'no "### Requirement:" headers found — imported as a single spec node',
        });
        items.push(specNode(rootPath, file, domain, { title: domain, body: text.trim() }));
        continue;
      }
      for (const requirement of requirements) {
        items.push(specNode(rootPath, file, domain, requirement));
      }
    }

    // 2. Changes, active and archived. An archived change keeps its whole
    //    bundle, which is the only reconstructable change history of the four
    //    source formats — dropping it because it is old throws that away.
    for (const [changesDir, archived] of [
      [path.join(base, 'changes'), false],
      [path.join(base, 'changes', 'archive'), true],
    ] as const) {
      for (const changeId of await readDirSafe(changesDir)) {
        if (!archived && changeId === 'archive') continue;
        const changeRoot = path.join(changesDir, changeId);
        if (!(await exists(path.join(changeRoot, 'proposal.md')))) continue;

        const nodes = await this.#parseChange(rootPath, changeRoot, changeId, archived, read);
        items.push(...nodes);
      }
    }

    return { items, warnings, skippedFiles };
  }

  async #parseChange(
    rootPath: string,
    changeRoot: string,
    changeId: string,
    archived: boolean,
    read: (file: string) => Promise<string | null>,
  ): Promise<readonly IrNode[]> {
    const items: IrNode[] = [];
    const changeRef = changeRefKey(changeId);

    const proposal = await read(path.join(changeRoot, 'proposal.md'));
    const design = await read(path.join(changeRoot, 'design.md'));

    items.push(
      IrNodeSchema.parse({
        kind: 'change',
        title: changeId,
        body: [proposal ?? '', design === null ? '' : `\n\n## Design\n\n${design}`].join('').trim(),
        frontmatterHints: { change_id: changeId, archived },
        externalRef: {
          source_tool: 'openspec',
          source_path: `${OPENSPEC_DIR}/changes/${changeId}`,
          source_id_or_hash: changeId,
        },
        preservedIdentifiers: [changeId],
      }),
    );

    // Implementation checklist → tasks, parented to the change.
    const tasks = await read(path.join(changeRoot, 'tasks.md'));
    if (tasks !== null) {
      for (const [index, task] of splitTasks(tasks).entries()) {
        items.push(
          IrNodeSchema.parse({
            kind: 'task',
            title: task.title,
            body: '',
            // `done` is carried as a hint rather than mapped to a lifecycle
            // state here: the writer owns lifecycle, and a parser asserting an
            // item is finished would be importing a claim as a fact.
            frontmatterHints: { change_id: changeId, source_checked: task.done },
            externalRef: {
              source_tool: 'openspec',
              source_path: `${OPENSPEC_DIR}/changes/${changeId}/tasks.md`,
              source_id_or_hash: sha(`${changeId}#${String(index)}#${task.title}`),
            },
            relations: [{ type: 'parent', targetExternalRef: changeRef }],
          }),
        );
      }
    }

    // Delta specs, which carry the ADDED/MODIFIED/REMOVED verb.
    const deltaSpecs = path.join(changeRoot, 'specs');
    for (const domain of await readDirSafe(deltaSpecs)) {
      const file = path.join(deltaSpecs, domain, 'spec.md');
      if (!(await exists(file))) continue;
      const text = await read(file);
      if (text === null) continue;
      for (const requirement of splitRequirements(text)) {
        items.push(specNode(rootPath, file, domain, requirement, changeId));
      }
    }

    return items;
  }
}

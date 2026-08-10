import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isTerminalStage,
  LifecycleStageSchema,
  WorkItemSchema,
  type WorkItem,
} from '@sdlc-on-fire/core';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';

/**
 * The typed writer — the only sanctioned way work-item files are written
 * (contracts/02-object-model.md §5.3, ADR-0013).
 *
 * Two guarantees live here and nowhere else:
 *
 *   1. Nothing reaches disk without validating against the object model.
 *   2. A work item whose *on-disk* stage is terminal is never edited in place.
 *
 * Both are hard write-path checks rather than conventions, because a convention
 * that only the well-behaved caller follows is not an invariant.
 */

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(
    readonly filePath: string,
    readonly issues: readonly string[],
  ) {
    super(`${filePath} does not match the work-item schema:\n  - ${issues.join('\n  - ')}`);
  }
}

export class TerminalItemError extends Error {
  override readonly name = 'TerminalItemError';
  constructor(
    readonly filePath: string,
    readonly stage: string,
  ) {
    super(
      `${filePath} is at terminal stage "${stage}" and cannot be edited in place. ` +
        'Create a new work item with `supersedes` or `corrects` pointing at it instead (ADR-0013).',
    );
  }
}

export interface ReadWorkItemResult {
  readonly item: WorkItem;
  /** The Markdown body below the frontmatter, preserved verbatim. */
  readonly body: string;
}

function issueStrings(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string[] {
  return error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
  );
}

/** Parses and validates a work-item file. */
export function parseWorkItem(raw: string, filePath = '<memory>'): ReadWorkItemResult {
  const parsed = parseFrontmatter(raw);
  const result = WorkItemSchema.safeParse(parsed.data);
  if (!result.success) throw new ValidationError(filePath, issueStrings(result.error));
  return { item: result.data, body: parsed.body };
}

export async function readWorkItem(filePath: string): Promise<ReadWorkItemResult> {
  return parseWorkItem(await fs.readFile(filePath, 'utf8'), filePath);
}

/**
 * Reads only the `lifecycle_state` already on disk, without validating the rest.
 *
 * The terminal check must run against the *existing* file even when that file
 * would fail validation today — otherwise a schema change could quietly unlock
 * editing of items that were legitimately finished under an older schema.
 * Returns `null` when the file does not exist or carries no readable stage.
 */
export async function readOnDiskStage(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }

  const parsed = parseFrontmatter(raw);
  const stage = parsed.data['lifecycle_state'];
  return typeof stage === 'string' ? stage : null;
}

export interface WriteWorkItemOptions {
  /**
   * Bypass the terminal-state check. Reserved for the daemon's selective
   * gate-reopen path (Phase 2 hard insertion), which is the one legitimate
   * reason to touch a finished item — contract §8 open question 2.
   */
  readonly allowTerminal?: boolean | undefined;
}

/**
 * Keys the schema does not model, carried through a rewrite untouched.
 *
 * Zod's `safeParse` returns only the keys it knows about, so serializing
 * `validated.data` **deletes everything else in the file** — a user's `owner:`,
 * a `jira_ref:`, a field from a newer schema this binary predates. That is a
 * content-in-git violation with the worst possible shape: an ordinary
 * `sdlc advance` destroys hand-written content in a git-tracked file, the
 * result parses cleanly, and nothing reports a loss.
 *
 * It also defeats the product. `verify:` is modelled on tasks but not features,
 * so a feature card carrying one had it deleted by the transition — and the very
 * next gate refused the item for "declares no `verify:` command", naming a field
 * the tool had just removed itself.
 *
 * Modelled keys still come from the validated object: a rewrite is the one place
 * that normalises them, and letting a raw input value win would defeat the
 * validation it just passed.
 */
function withUnmodelledKeys(
  item: WorkItem,
  validated: Record<string, unknown>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (!(key in validated) && value !== undefined) extra[key] = value;
  }
  return { ...extra, ...validated };
}

/** Renders a validated work item to canonical Markdown. Pure — writes nothing. */
export function renderWorkItem(item: WorkItem, body: string): string {
  const validated = WorkItemSchema.safeParse(item);
  if (!validated.success) throw new ValidationError('<memory>', issueStrings(validated.error));
  return serializeFrontmatter(withUnmodelledKeys(item, validated.data), body);
}

/**
 * Validates, checks the on-disk terminal state, and writes canonically.
 *
 * The terminal check reads the frontmatter *about to be overwritten*, not the
 * incoming item — an agent that sets `lifecycle_state: implement` on a finished
 * task must not thereby be allowed to edit it.
 */
export async function writeWorkItem(
  filePath: string,
  item: WorkItem,
  body: string,
  options?: WriteWorkItemOptions,
): Promise<void> {
  const validated = WorkItemSchema.safeParse(item);
  if (!validated.success) throw new ValidationError(filePath, issueStrings(validated.error));

  if (options?.allowTerminal !== true) {
    const existingStage = await readOnDiskStage(filePath);
    if (existingStage !== null) {
      const parsedStage = LifecycleStageSchema.safeParse(existingStage);
      if (parsedStage.success && isTerminalStage(parsedStage.data)) {
        throw new TerminalItemError(filePath, existingStage);
      }
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    serializeFrontmatter(withUnmodelledKeys(item, validated.data), body),
    'utf8',
  );
}

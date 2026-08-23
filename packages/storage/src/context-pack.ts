/**
 * Persisting the context pack a run was actually given (P6-WRITEPATH-03).
 *
 * The pack is **content, not state**: it lives under `.sdlc/`, it is written
 * once, and it survives `db:rebuild`. The database holds only the path.
 *
 * Two rules:
 *
 * 1. **Written before the agent runs**, like the run row. A pack saved on
 *    completion does not exist for the dispatch that hung — and "what were we
 *    even asking it to do" is the first question anybody has about a run that
 *    went wrong.
 *
 * 2. **Never overwritten.** The pack on disk is the evidence of what was
 *    actually sent. Rewriting it for a re-run under the same id would make the
 *    record disagree with what happened, silently, in the direction of
 *    whatever is most recent.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { contextPackPath } from '@sdlc-on-fire/core';

export interface PersistedPack {
  /** Relative to the workspace root — what goes in `runs.context_pack_path`. */
  readonly relativePath: string;
  /** False when a pack for this run already existed and was left alone. */
  readonly written: boolean;
}

export async function persistContextPack(
  workspaceRoot: string,
  runId: string,
  rendered: string,
): Promise<PersistedPack> {
  const relativePath = contextPackPath(runId);
  const absolute = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    // `wx` fails when the file exists rather than truncating it. Checking first
    // and then writing would leave a window in which two dispatches both see
    // nothing and both write; the flag makes it the filesystem's problem.
    await fs.writeFile(absolute, rendered, { encoding: 'utf8', flag: 'wx' });
    return { relativePath, written: true };
  } catch (cause) {
    if ((cause as { code?: string }).code === 'EEXIST') {
      return { relativePath, written: false };
    }
    throw cause;
  }
}

/** Read back the pack a run was given, or null when none was recorded. */
export async function readContextPack(
  workspaceRoot: string,
  runId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceRoot, contextPackPath(runId)), 'utf8');
  } catch {
    return null;
  }
}

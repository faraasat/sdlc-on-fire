import { createHash } from 'node:crypto';
import {
  MEMORY_SOURCES,
  MEMORY_TYPES,
  MemoryEntrySchema,
  scoreMemory,
  type MemoryEntry,
} from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc memory` — the project's typed memory (P1-OBJ-04, ADR-0023).
 *
 * Reachable from the start rather than added later, because the failure this
 * design is built around is invisible from the inside: a memory store fails by
 * accumulating, and a wrong remembered fact is retrieved with exactly the same
 * confidence as a right one. If nobody can *read* what is remembered, nobody
 * ever notices the store has drifted.
 *
 * So `list` shows what is currently believed, and `history` shows the
 * supersession chain for one subject — the "why did we change our mind" trail
 * the bi-temporal columns exist to keep.
 */

export interface MemoryRecordResult {
  readonly recorded: boolean;
  readonly entry: MemoryEntry | null;
  /** Why nothing was written, when nothing was. */
  readonly reason?: string | undefined;
}

/** Content hash over the claim itself — the duplicate check depends on it. */
export function memoryContentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title.trim()} ${body.trim()}`, 'utf8').digest('hex');
}

export async function recordMemory(
  root: string,
  input: {
    type: string;
    title: string;
    body: string;
    source: string;
    writtenBy: string;
    workItemId?: string | undefined;
    importance?: number | undefined;
    validFrom?: string | undefined;
  },
): Promise<MemoryRecordResult> {
  if (!(MEMORY_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(
      `unknown memory type "${input.type}" — expected one of ${MEMORY_TYPES.join(', ')}`,
    );
  }
  if (!(MEMORY_SOURCES as readonly string[]).includes(input.source)) {
    throw new Error(
      `unknown source "${input.source}" — expected one of ${MEMORY_SOURCES.join(', ')}. ` +
        'Provenance is required: an entry whose origin is unknown cannot be judged later.',
    );
  }

  const entry = MemoryEntrySchema.parse({
    type: input.type,
    ...(input.workItemId === undefined ? {} : { work_item_id: input.workItemId }),
    title: input.title,
    body: input.body,
    source_type: input.source,
    written_by: input.writtenBy,
    ...(input.importance === undefined ? {} : { importance: input.importance }),
    valid_from: input.validFrom ?? new Date().toISOString(),
    content_hash: memoryContentHash(input.title, input.body),
  });

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const written = await port.recordMemory(entry);
    return written === null
      ? {
          recorded: false,
          entry: null,
          reason:
            'an identical claim is already recorded — re-asserting a belief is not a correction, ' +
            'and recording it again is how a memory store fills with noise',
        }
      : { recorded: true, entry: written };
  } finally {
    await db.close();
  }
}

export interface MemoryListing {
  readonly entries: readonly (MemoryEntry & { readonly score: number })[];
}

export async function listMemory(
  root: string,
  filter: { workItemId?: string | undefined; type?: string | undefined } = {},
): Promise<MemoryListing> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const entries = await port.currentMemory(filter);
    const now = new Date();
    return {
      // Ranked by the formula, not by a model call — two callers ranking the
      // same rows at the same instant get the same order. `similarity` is 0
      // because v0.1 has no embedding retrieval on this path, and imputing a
      // number we did not compute would be worse than contributing nothing.
      entries: entries
        .map((entry) => ({ ...entry, score: scoreMemory(entry, 0, now) }))
        .sort((a, b) => b.score - a.score),
    };
  } finally {
    await db.close();
  }
}

export async function memoryHistory(root: string, title: string): Promise<readonly MemoryEntry[]> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    return await port.memoryHistory(title);
  } finally {
    await db.close();
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { contentHash, type SourcePointer } from '@sdlc-on-fire/core';
import { chunkMarkdown, type Chunk } from './chunking.js';

/**
 * Source-pointer rehydration (P1-CTX-08, ADR-0021).
 *
 * Compaction throws detail away. Usually that is the whole point; occasionally a
 * later stage turns out to need something the summary dropped, and the only
 * remedy without this is to re-run the stage that produced it — paying for the
 * entire prior stage to recover one paragraph.
 *
 * A source pointer makes that a file read and a range slice. The pointer records
 * the run, the stage, the artifact and the chunk range, plus a hash of what was
 * there at compaction time.
 *
 * The hash is the part that matters. Returning *some* text for a pointer is easy
 * and worthless: if the artifact has since been rewritten, the caller would be
 * handed content that was never summarised while believing it was looking at the
 * original. So drift is reported, never papered over.
 */

/** Why a rehydration attempt did not return content. */
export type RehydrationFailure = 'missing-artifact' | 'range-out-of-bounds' | 'content-changed';

export type RehydrationResult =
  | {
      readonly ok: true;
      readonly chunks: readonly Chunk[];
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly failure: RehydrationFailure;
      readonly detail: string;
      /**
       * What is at the pointer *now*, when the artifact still exists.
       *
       * Offered separately from `ok` on purpose: a caller may well decide that
       * drifted content is better than nothing, but it has to make that decision
       * knowingly rather than by not noticing.
       */
      readonly current?: readonly Chunk[];
    };

/**
 * Fetches the pre-compaction content a summary was folded from.
 *
 * `workspaceRoot` anchors the pointer's relative artifact path; a pointer that
 * escapes the workspace is refused rather than followed, because a stored
 * pointer is data and data does not get to name arbitrary files on the host.
 */
export async function rehydrate(
  workspaceRoot: string,
  pointer: SourcePointer,
): Promise<RehydrationResult> {
  const resolved = path.resolve(workspaceRoot, pointer.artifact);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return {
      ok: false,
      failure: 'missing-artifact',
      detail: `source pointer "${pointer.artifact}" resolves outside the workspace`,
    };
  }

  let source: string;
  try {
    source = await fs.readFile(resolved, 'utf8');
  } catch {
    return {
      ok: false,
      failure: 'missing-artifact',
      detail: `no artifact at ${pointer.artifact} (run ${pointer.runId}, stage ${pointer.stage})`,
    };
  }

  const all = chunkMarkdown(source);
  const slice = all.slice(pointer.chunkFrom, pointer.chunkTo + 1);
  if (slice.length === 0) {
    return {
      ok: false,
      failure: 'range-out-of-bounds',
      detail:
        `chunks ${String(pointer.chunkFrom)}..${String(pointer.chunkTo)} are outside ` +
        `${pointer.artifact}, which now has ${String(all.length)} chunk(s)`,
    };
  }

  const text = joinChunks(slice);
  const actual = contentHash(text);
  if (actual !== pointer.contentHash) {
    return {
      ok: false,
      failure: 'content-changed',
      detail:
        `${pointer.artifact} chunks ${String(pointer.chunkFrom)}..${String(pointer.chunkTo)} ` +
        `hashed ${pointer.contentHash.slice(0, 12)} when summarised and ${actual.slice(0, 12)} now`,
      current: slice,
    };
  }

  return { ok: true, chunks: slice, text };
}

/**
 * Builds a pointer for content about to be compacted.
 *
 * The hash is taken here, over the same joined text {@link rehydrate} will
 * reconstruct. Hashing the raw file instead would make an unrelated edit
 * elsewhere in the artifact look like drift in this range.
 */
export function sourcePointerFor(input: {
  readonly runId: string;
  readonly stage: SourcePointer['stage'];
  readonly artifact: string;
  readonly chunks: readonly Chunk[];
  readonly from: number;
  readonly to: number;
}): SourcePointer {
  const slice = input.chunks.slice(input.from, input.to + 1);
  return {
    runId: input.runId,
    stage: input.stage,
    artifact: input.artifact,
    chunkFrom: input.from,
    chunkTo: input.to,
    contentHash: contentHash(joinChunks(slice)),
  };
}

/** One separator, defined once — the hash on both sides depends on it agreeing. */
function joinChunks(chunks: readonly Chunk[]): string {
  return chunks.map((chunk) => chunk.text).join('\n\n');
}

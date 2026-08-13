import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  authorizeTerminalWrite,
  contentPreserved,
  isLifecycleStage,
  isTerminalStage,
  type TerminalWriteGrounds,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';

/**
 * Compare-and-swap for lifecycle writes (P1-LIFE-04, FEAT-STORE-023).
 *
 * A lifecycle transition is read-decide-write: read the card, evaluate guards
 * and the gate, rewrite the card. Between the read and the write, anything can
 * happen to the file — a second `sdlc advance`, a teammate's editor, a `git
 * checkout`. A blind write at the end silently discards whatever arrived in
 * between, and the discarded write is the one nobody notices, because the file
 * afterwards looks entirely plausible.
 *
 * The claim/lease (ADR-0048) covers a different race: it stops two *actors* from
 * both owning an item. It does nothing about one actor with two terminals, or an
 * agent and a human, or a rebase landing mid-decision — a lease is an agreement,
 * and this is a check.
 *
 * The comparison is on **file content**, not `updated_at`. A timestamp with
 * second resolution cannot distinguish two writes in the same second, and the
 * card's own `updated_at` is a field a writer sets — using it as the version
 * would let a careless writer defeat the check by not updating it.
 */

export class ConcurrentModificationError extends Error {
  override readonly name = 'ConcurrentModificationError';
  constructor(
    readonly filePath: string,
    readonly workItemId: string,
  ) {
    super(
      `${workItemId} changed on disk while this transition was being decided (${filePath}). ` +
        'Nothing was written — the decision was made against content that no longer exists. ' +
        'Re-run the command to decide against the current card.',
    );
  }
}

/** The version token for a card: a hash of exactly the bytes that were read. */
export function versionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Writes a card only if it still holds the content the caller read.
 *
 * Refuses rather than retries. A retry would have to re-run the guards and the
 * gate against the new content to be correct, and a retry that *didn't* would
 * re-apply a decision made about a card that no longer exists — which is the
 * bug, wearing a loop. The caller re-running the whole command is the honest
 * retry, and it is one command.
 *
 * The read-back is not free of races either — nothing short of file locking is —
 * but it closes the window from "the whole decision" down to "two adjacent
 * syscalls", and it does so without a lock file that can be orphaned by a crash.
 */
export class TerminalWriteError extends Error {
  override readonly name = 'TerminalWriteError';
  constructor(
    readonly filePath: string,
    readonly workItemId: string,
    readonly reasons: readonly string[],
  ) {
    super(
      `${workItemId} is at a terminal stage and this write has no recognised grounds (${filePath}):\n  - ` +
        (reasons.length === 0
          ? 'none offered — create a new work item with `supersedes` or `corrects` instead (ADR-0013).'
          : reasons.join('\n  - ')),
    );
  }
}

export async function writeCardIfUnchanged(
  filePath: string,
  expectedVersion: string,
  contents: string,
  workItemId: string,
  grounds?: TerminalWriteGrounds,
): Promise<void> {
  const current = await fs.readFile(filePath, 'utf8').catch(() => null);
  if (current === null || versionOf(current) !== expectedVersion) {
    throw new ConcurrentModificationError(filePath, workItemId);
  }

  // The terminal check belongs here as well as in the typed writer, and the
  // reason is the whole argument for storage-layer enforcement (`.research/11
  // §3`): the refusal is pushed down so that *no workflow* can route around
  // it. This path did route around it — it renders and writes bytes without
  // ever calling `writeWorkItem` — so the invariant held only for callers that
  // happened to use the other door. An invariant with two doors and a guard on
  // one is a convention.
  const before = parseFrontmatter(current);
  const stage = before.data['lifecycle_state'];
  if (typeof stage === 'string' && isLifecycleStage(stage) && isTerminalStage(stage)) {
    const after = parseFrontmatter(contents);
    const verdict =
      grounds === undefined
        ? { allowed: false, reasons: [] as readonly string[] }
        : authorizeTerminalWrite(
            grounds,
            contentPreserved(before.data, before.body, after.data, after.body),
          );
    if (!verdict.allowed) throw new TerminalWriteError(filePath, workItemId, verdict.reasons);
  }

  await fs.writeFile(filePath, contents, 'utf8');
}

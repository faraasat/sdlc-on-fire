import { isTerminalStage, isLifecycleStage, type StoragePort } from '@sdlc-on-fire/core';

/**
 * Read-time attestation: does a work item's claimed state survive contact with
 * its own evidence?
 *
 * An adversarial evaluation found the hole this closes. `advance` gates a
 * transition correctly — but it is the *only* enforcement point, and the cards
 * are plain files in git. Hand-edit `lifecycle_state: done` and every read path
 * reported the item as cleanly done, permanently, while the tool's own evidence
 * table held two recorded failures for it.
 *
 * We cannot stop someone editing a file; content in git is the source of truth
 * by design, and a tool that fought that would be fighting its own architecture.
 * What we can do is refuse to *repeat* the claim. A `done` that no passing
 * evidence supports is reported as unsupported everywhere it is displayed —
 * so the lie survives exactly as long as nobody looks, and no longer.
 *
 * This is the difference between prevention and detection, and detection is the
 * honest guarantee here. Saying so plainly beats implying a lock that isn't
 * there.
 */

/**
 * `stale` is separate from `unsupported`, and the separation is the point.
 *
 * A blind evaluation ran the two together and got the result exactly backwards:
 * an honestly-finished item was flagged `unsupported` because an *unrelated*
 * task's file changed the shared working tree, while a fabricated one stayed
 * `supported` because its no-op verify command was insensitive to the tree by
 * construction. The louder warning landed on the honest work.
 *
 * They are different claims. `stale` says "this passed, and the tree has moved
 * since — re-run to confirm". `unsupported` says "the evidence does not back
 * this claim at all". Collapsing them makes the flag fire constantly in any
 * workspace with two items in flight, and a flag that always fires is one nobody
 * reads.
 */
export type Attestation = 'supported' | 'stale' | 'unsupported' | 'not-applicable';

export interface AttestedItem {
  readonly id: string;
  readonly lifecycleState: string;
  readonly attestation: Attestation;
  /** Present when `unsupported` — what is wrong, in one line. */
  readonly concern?: string | undefined;
}

interface EvidenceRow {
  readonly payload: unknown;
  readonly producer: string;
  readonly git_sha: string;
  readonly dirty_tree_hash: string | null;
  readonly command: { cmd?: string; args?: string[] } | null;
  readonly produced_at: Date | string;
}

/**
 * The verify command an envelope actually ran.
 *
 * `runVerify` executes `/bin/sh -c <command>`, so the command is the second
 * argument. Read back rather than stored separately: one record of what ran,
 * not two that can disagree.
 */
export function recordedCommand(command: { cmd?: string; args?: string[] } | null): string | null {
  const args = command?.args;
  if (args === undefined || args.length === 0) return null;
  return args.at(-1) ?? null;
}

/** The tree the claim is being attested *against*. */
export interface TreeContext {
  readonly headSha: string;
  readonly dirtyTreeHash?: string | undefined;
}

/**
 * Checks one item's terminal claim against recorded evidence.
 *
 * Only terminal stages are checked. An item mid-flight has not claimed anything
 * yet, and flagging it would train people to ignore the flag — the warning has
 * to be rare enough to mean something.
 *
 * The evidence is reached through `gates` → `gate_evidence`, never by querying
 * `evidence` directly. The first version of this function did query it directly,
 * and an adversarial evaluation found the consequence immediately: one failing
 * verify anywhere flipped the warning on for every item in the workspace, and
 * one passing run anywhere cleared it for all of them — including items that had
 * never been verified at all. A flag that means "something, somewhere" means
 * nothing.
 */
export async function attestItem(
  store: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> },
  id: string,
  lifecycleState: string,
  tree?: TreeContext,
  /**
   * The card's *current* `verify:` command.
   *
   * The exploit this closes needed no code change and no hidden flag: edit one
   * line of YAML so `verify: pnpm test` becomes `verify: "true"`, re-run verify
   * and advance, and the item reaches `done` with passing evidence while the
   * real suite fails untouched. Every check downstream was satisfied, because
   * from its point of view the check genuinely passed — the card had lied about
   * what "verify" means.
   *
   * Evidence records the command it ran. Comparing it to the command the card
   * now declares is the deterministic disposer: evidence produced by a different
   * check is not evidence about this one.
   */
  expectedCommand?: string,
): Promise<AttestedItem> {
  if (!isLifecycleStage(lifecycleState) || !isTerminalStage(lifecycleState)) {
    return { id, lifecycleState, attestation: 'not-applicable' };
  }

  const rows = await store.query<EvidenceRow>(
    `SELECT e.payload, e.producer, e.git_sha, e.dirty_tree_hash, e.command, e.produced_at
       FROM evidence e
       JOIN gate_evidence ge ON ge.evidence_id = e.id
       JOIN gates g ON g.id = ge.gate_id
      WHERE g.work_item_id = $1 AND e.kind = 'test'
      ORDER BY e.produced_at DESC LIMIT 20;`,
    [id],
  );

  // Only evidence we produced counts. An agent-claim row backing a `done` is
  // precisely the claim this product exists to disbelieve.
  const gating = rows.filter((row) => row.producer !== 'agent-claim');
  if (gating.length === 0) {
    return {
      id,
      lifecycleState,
      attestation: 'unsupported',
      concern: `marked "${lifecycleState}" but no verify run was ever recorded for it — run \`sdlc verify ${id}\``,
    };
  }

  const latest = gating[0];
  const payload = latest?.payload as { ok?: boolean; report?: string; total?: number } | undefined;
  // A parsed report of zero tests is a green run that proved nothing. This is
  // distinct from `report: 'exit-code-only'`, where we genuinely could not read
  // a count and say so rather than guessing.
  if (payload?.report === 'parsed' && (payload.total ?? 0) === 0) {
    return {
      id,
      lifecycleState,
      attestation: 'unsupported',
      concern: `marked "${lifecycleState}" but its verify run executed 0 tests — an empty suite is not evidence`,
    };
  }

  if (payload?.ok !== true) {
    return {
      id,
      lifecycleState,
      attestation: 'unsupported',
      concern: `marked "${lifecycleState}" but the most recent recorded verify run FAILED`,
    };
  }

  // The card must still be asking for the check that produced this evidence.
  // Checked before staleness because it is the harder failure: a stale run
  // proved something about older code, a swapped command proved nothing at all.
  if (expectedCommand !== undefined && latest !== undefined) {
    const ran = recordedCommand(latest.command);
    if (ran !== null && ran.trim() !== expectedCommand.trim()) {
      return {
        id,
        lifecycleState,
        attestation: 'unsupported',
        concern:
          `marked "${lifecycleState}" on evidence from \`${ran}\`, but the card now declares ` +
          `\`verify: ${expectedCommand}\`. The check changed after it passed — re-run \`sdlc verify ${id}\`.`,
      };
    }
  }

  // Evidence about a different tree is not evidence about this one. Reported as
  // *stale* rather than unsupported: the run really did pass, against code that
  // has since moved. Treating that as equivalent to "no evidence" put the louder
  // warning on honest work while a fabricated claim went unflagged.
  if (tree !== undefined && latest !== undefined) {
    const evidenceDirty = latest.dirty_tree_hash ?? undefined;
    if (latest.git_sha !== tree.headSha || evidenceDirty !== tree.dirtyTreeHash) {
      return {
        id,
        lifecycleState,
        attestation: 'stale',
        concern: `marked "${lifecycleState}" on a run that passed against an earlier working tree — re-run \`sdlc verify ${id}\` to confirm it still does`,
      };
    }
  }

  return { id, lifecycleState, attestation: 'supported' };
}

/** Attests every item, for `list` and `status`. */
export async function attestAll(
  store: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> },
  items: readonly { id: string; lifecycleState: string; verifyCommand?: string | undefined }[],
  tree?: TreeContext,
): Promise<readonly AttestedItem[]> {
  const results: AttestedItem[] = [];
  for (const item of items) {
    results.push(await attestItem(store, item.id, item.lifecycleState, tree, item.verifyCommand));
  }
  return results;
}

/**
 * How many claims their own evidence does not back.
 *
 * `stale` is excluded deliberately — it is a prompt to re-run, not a claim that
 * something is wrong, and counting it here would restore exactly the conflation
 * this split exists to undo.
 */
export function unsupportedCount(attestations: readonly AttestedItem[]): number {
  return attestations.filter((entry) => entry.attestation === 'unsupported').length;
}

export type { StoragePort };

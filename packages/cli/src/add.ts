import fs from 'node:fs/promises';
import {
  insertionShapeFor,
  reWaveScope,
  type InFlightItem,
  type InsertionShapeDecision,
  type ReWaveScope,
} from '@sdlc-on-fire/core';
import { recordRisks } from './risk-record-store.js';
import path from 'node:path';
import {
  computeBlastRadius,
  evaluateInsertion,
  formatBlastRadius,
  insertionRecord,
  resolveWorkspaceLayout,
  type BlastRadius,
  type InsertionRequest,
  type InsertionVerdict,
  type RescopeApproval,
  type WorkItemNode,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { findWorkItem, nextSequence } from './commands.js';

/**
 * `sdlc add --into` — hard insertion (P2-INS-01, contract 06 §3.5).
 *
 * The tier above `capture`. Capturing costs nothing because it changes
 * nothing; this puts new work into a container somebody is already working
 * through, so it lands at `proposed` and stays there until a human with a
 * rescope role says otherwise.
 *
 * The command's real output is not the work item — it is the blast radius,
 * printed before the approval is asked for, and written to
 * `kanban/_insertions/INSERT-NNN.md` whether the answer turns out to be yes or
 * no.
 */

/** Where hard-insertion records live (contract 06 §3.5). */
export const INSERTIONS_DIR = '_insertions';

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Reads the work-item graph off disk.
 *
 * `inFlight` is taken from the claim display fields (contract 06 §3.3): an item
 * is in flight when somebody holds an unexpired claim on it. That is a *display
 * cache* and the authoritative lease lives in the DB (ADR-0048), so this
 * over-reports at worst — a stale `claimed_by` produces an extra caution, never
 * a missing one. Under-reporting is the direction that would matter.
 */
export async function readGraph(kanbanDir: string, now = new Date()): Promise<WorkItemNode[]> {
  const nodes: WorkItemNode[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === INSERTIONS_DIR) continue;
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;

      const raw = await fs.readFile(full, 'utf8').catch(() => '');
      const { data } = parseFrontmatter(raw);
      const id = data['id'];
      if (typeof id !== 'string') continue;

      const parent = data['parent'] ?? data['parent_id'];
      const expiresAt = data['claim_expires_at'];
      const claimed = typeof data['claimed_by'] === 'string' && data['claimed_by'] !== '';
      const unexpired =
        typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))
          ? claimed
          : Date.parse(expiresAt) > now.getTime();

      nodes.push({
        id,
        ...(typeof parent === 'string' ? { parentId: parent } : {}),
        relatesTo: asStringArray(data['relates_to']),
        blocks: asStringArray(data['blocks']),
        blockedBy: asStringArray(data['blocked_by']),
        ownedPaths: asStringArray(data['owned_paths']),
        inFlight: claimed && unexpired,
      });
    }
  };

  await walk(kanbanDir);
  return nodes;
}

export interface AddOptions {
  readonly kind: string;
  readonly title: string;
  readonly into: string;
  readonly after?: string | undefined;
  readonly why?: string | undefined;
  readonly workType?: string | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  /**
   * Approvals already on record.
   *
   * Deliberately an input rather than something this command can mint. There is
   * no flag that approves an insertion, because a flag on the same command line
   * that proposes it is not a second person.
   */
  readonly approvals?: readonly RescopeApproval[] | undefined;
}

export interface AddResult {
  readonly workItemId: string;
  readonly recordId: string;
  readonly recordPath: string;
  readonly state: InsertionVerdict['state'];
  readonly blockers: readonly string[];
  readonly cautions: readonly string[];
  readonly radius: BlastRadius;
  /** Which items in the radius get re-planned, and which are left alone. */
  readonly scope: ReWaveScope;
  /** Whether this may change the target, or must become a follow-up. */
  readonly shape: InsertionShapeDecision;
  /** Present when file-ownership collisions were recorded, or failed to be. */
  readonly riskNote?: string | undefined;
}

export async function addIntoContainer(root: string, options: AddOptions): Promise<AddResult> {
  const layout = resolveWorkspaceLayout(root);

  const container = await findWorkItem(layout.kanbanDir, options.into);
  if (container === null) {
    throw new Error(
      `no container with id "${options.into}" under ${layout.kanbanDir} — hard insertion targets an existing epic or sprint`,
    );
  }

  const nodes = await readGraph(layout.kanbanDir);
  const radius = computeBlastRadius(
    {
      into: options.into,
      workType: options.workType ?? 'feature',
      ...(options.ownedPaths === undefined ? {} : { ownedPaths: options.ownedPaths }),
    },
    nodes,
  );

  // The re-wave scope and the insertion shape, from the radius that was just
  // computed (P6-INFLIGHT-01, P6-INFLIGHT-02). `blast-radius.ts` has described
  // "re-plan the affected subgraph" in a comment since P2-INS-01 and nothing
  // ever decided what to do with the subgraph it computed.
  const board = await readBoardState(layout.kanbanDir);
  const scope = reWaveScope(radius, board);
  const shape = insertionShapeFor(board.find((entry) => entry.id === options.into));

  const { WORK_ITEM_ID_PREFIX, formatWorkItemId } = await import('@sdlc-on-fire/core');
  if (!(options.kind in WORK_ITEM_ID_PREFIX)) {
    throw new Error(
      `unknown kind "${options.kind}" — expected one of ${Object.keys(WORK_ITEM_ID_PREFIX).join(', ')}`,
    );
  }
  const typedKind = options.kind as keyof typeof WORK_ITEM_ID_PREFIX;
  const workItemId = formatWorkItemId(
    typedKind,
    await nextSequence(layout.kanbanDir, WORK_ITEM_ID_PREFIX[typedKind]),
  );

  const request: InsertionRequest = {
    id: workItemId,
    kind: options.kind,
    title: options.title,
    into: options.into,
    ...(options.after === undefined ? {} : { after: options.after }),
    ...(options.why === undefined ? {} : { justification: options.why }),
  };
  const verdict = evaluateInsertion(request, radius, options.approvals ?? []);

  const insertionsDir = path.join(layout.kanbanDir, INSERTIONS_DIR);
  await fs.mkdir(insertionsDir, { recursive: true });
  const recordId = `INSERT-${String(await nextSequence(layout.kanbanDir, 'INSERT')).padStart(3, '0')}`;
  const recordPath = path.join(insertionsDir, `${recordId}.md`);

  // Written before anything else lands, and written for every outcome. An
  // audit trail that only records what was approved cannot answer the question
  // it exists to answer.
  await fs.writeFile(
    recordPath,
    insertionRecord(recordId, request, radius, verdict, new Date().toISOString()),
    'utf8',
  );

  // File-ownership collisions become risk records (P6-WRITEPATH-02,
  // P6-INFLIGHT-03). The blast-radius scan has always *found* them and always
  // only printed them, so a collision noticed at insertion left no trace once
  // the terminal scrolled — and the person who hits it three days later, mid
  // merge, has no record that anybody knew.
  //
  // `overlap` findings are deliberately not recorded: overlap is common,
  // usually fine, and a card per overlap turns the risk directory into a place
  // nobody looks.
  //
  // Never fails the insertion. A register that can stop the work is worse than
  // none — but a failure to write is reported, because a writer that quietly
  // does nothing is how `runs` and the context packs stayed empty.
  const collisions = radius.ownership
    .filter((finding) => finding.severity === 'conflict')
    .flatMap((finding) =>
      finding.paths.map((filePath) => ({ path: filePath, withItem: finding.itemId })),
    );

  let riskNote: string | undefined;
  if (collisions.length > 0) {
    try {
      const recorded = await recordRisks(layout.root, workItemId, [], () => new Date(), collisions);
      if (recorded.created.length > 0) {
        riskNote = `recorded ${String(recorded.created.length)} ownership risk(s) under ${recorded.dir}: ${recorded.created.map((r) => r.id).join(', ')}`;
      }
    } catch (cause) {
      riskNote = `ownership risks were NOT recorded: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  return {
    workItemId,
    recordId,
    recordPath: path.relative(layout.root, recordPath),
    state: verdict.state,
    blockers: verdict.blockers,
    cautions: verdict.cautions,
    radius,
    scope,
    shape,
    ...(riskNote === undefined ? {} : { riskNote }),
  };
}

export function formatAdd(result: AddResult): string {
  const lines = [
    `${result.workItemId} proposed → ${result.recordPath}`,
    '',
    formatBlastRadius(result.radius),
    '',
  ];

  // The shape first: whether this changes the target at all is the decision the
  // reader most needs, and burying it under a radius table is how it gets
  // skimmed past.
  lines.push(
    result.shape.shape === 'follow-up'
      ? `↳ FOLLOW-UP, not a change to ${result.radius.target} — ${result.shape.because}`
      : `→ may change ${result.radius.target} — ${result.shape.because}`,
    '',
  );
  if (result.scope.leftAlone.length > 0) {
    // Named, with the reason. "Some items were skipped" is the version of this
    // that gets ignored.
    lines.push('Left alone by the re-wave:');
    for (const skipped of result.scope.leftAlone) {
      lines.push(`  ${skipped.id} — ${skipped.because}`);
    }
    lines.push('');
  }
  if (result.riskNote !== undefined) lines.push(`  ${result.riskNote}`, '');
  if (result.state === 'approved') {
    lines.push(`✓ rescope approved — ${result.workItemId} may enter ${result.radius.target}.`);
  } else if (result.state === 'rejected') {
    lines.push('✗ rescope rejected. The record keeps the request and the reason.');
  } else {
    lines.push(`Held at proposed:`);
    for (const blocker of result.blockers) lines.push(`  - ${blocker}`);
  }

  if (result.cautions.length > 0) {
    lines.push('', 'For the approver to read first:');
    for (const caution of result.cautions) lines.push(`  - ${caution}`);
  }

  return lines.join('\n');
}

/**
 * The board, in the shape the re-wave decision needs (P6-INFLIGHT-01).
 *
 * Read from the cards rather than the mirror, for the same reason everything
 * else here is: the cards are the source of truth, and a decision about what to
 * disturb must not be made against a mirror that a `db:rebuild` has not caught
 * up with.
 */
async function readBoardState(kanbanDir: string): Promise<readonly InFlightItem[]> {
  const items: InFlightItem[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === INSERTIONS_DIR) continue;
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const { data } = parseFrontmatter(await fs.readFile(full, 'utf8').catch(() => ''));
      const id = data['id'];
      if (typeof id !== 'string') continue;
      items.push({
        id,
        lifecycleState: typeof data['lifecycle_state'] === 'string' ? data['lifecycle_state'] : '',
        claimedBy: typeof data['claimed_by'] === 'string' ? data['claimed_by'] : null,
        prUrl: typeof data['pr_url'] === 'string' ? data['pr_url'] : null,
      });
    }
  };
  await walk(kanbanDir);
  return items;
}

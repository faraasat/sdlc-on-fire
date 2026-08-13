import fs from 'node:fs/promises';
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

  return {
    workItemId,
    recordId,
    recordPath: path.relative(layout.root, recordPath),
    state: verdict.state,
    blockers: verdict.blockers,
    cautions: verdict.cautions,
    radius,
  };
}

export function formatAdd(result: AddResult): string {
  const lines = [
    `${result.workItemId} proposed → ${result.recordPath}`,
    '',
    formatBlastRadius(result.radius),
    '',
  ];

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

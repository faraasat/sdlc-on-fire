import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatReopenPlan,
  planReopen,
  reopenAuditEntry,
  resolveWorkspaceLayout,
  type GateCoverage,
  type ReopenPlan,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { INSERTIONS_DIR } from './add.js';

/**
 * `sdlc reopen` — selective gate re-open against an approved insertion
 * (P2-INS-02).
 *
 * Deliberately keyed on an insertion record rather than taking a bare list of
 * files. The authority to re-open a gate on finished work comes from an
 * approved rescope (P2-INS-01); a command that re-opened gates for any diff at
 * all would be a way around the approval rather than a consequence of it.
 */

export interface ReopenResult {
  readonly insertionId: string;
  readonly insertionState: string;
  readonly recordPath: string;
  readonly plan: ReopenPlan;
  readonly blastRadius: readonly string[];
}

export class UnapprovedInsertionError extends Error {
  override readonly name = 'UnapprovedInsertionError';
  constructor(insertionId: string, state: string) {
    super(
      `${insertionId} is ${state}, not approved — a proposed or rejected insertion cannot re-open gates on finished work (ADR-0013, P2-INS-02).`,
    );
  }
}

/** The work items an insertion record says its blast radius reached. */
export function radiusFromRecord(body: string): readonly string[] {
  const section = /## Blast radius\n([\s\S]*?)(?=\n## |$)/.exec(body);
  if (section?.[1] === undefined) return [];
  return [...section[1].matchAll(/^- ([A-Z]+-\d+)/gm)].map((match) => match[1] ?? '');
}

export interface ReopenOptions {
  readonly insertionId: string;
  readonly changed: readonly string[];
  readonly requirements: readonly string[];
  readonly coverage?: readonly GateCoverage[] | undefined;
  readonly workType?: string | undefined;
  /** Write the audit section. False computes the plan and touches nothing. */
  readonly apply?: boolean | undefined;
}

export async function reopenGates(root: string, options: ReopenOptions): Promise<ReopenResult> {
  const layout = resolveWorkspaceLayout(root);
  const recordPath = path.join(layout.kanbanDir, INSERTIONS_DIR, `${options.insertionId}.md`);

  const raw = await fs.readFile(recordPath, 'utf8').catch(() => null);
  if (raw === null) throw new Error(`no insertion record at ${recordPath}`);

  const parsed = parseFrontmatter(raw);
  const state = typeof parsed.data['state'] === 'string' ? parsed.data['state'] : 'unknown';
  if (state !== 'approved') throw new UnapprovedInsertionError(options.insertionId, state);

  const plan = planReopen(
    options.requirements,
    options.changed.map((p) => ({ path: p })),
    options.coverage ?? [],
    options.workType ?? 'feature',
  );

  if (options.apply === true) {
    // Appended, never rewritten. The record is an audit trail, and an audit
    // trail that gets edited in place is the failure this whole subsystem
    // exists to prevent, committed against its own evidence.
    await fs.appendFile(
      recordPath,
      reopenAuditEntry(plan, options.changed, new Date().toISOString()),
      'utf8',
    );
  }

  return {
    insertionId: options.insertionId,
    insertionState: state,
    recordPath: path.relative(layout.root, recordPath),
    plan,
    blastRadius: radiusFromRecord(parsed.body),
  };
}

export function formatReopen(result: ReopenResult): string {
  return [
    `${result.insertionId} (${result.insertionState}) → ${result.recordPath}`,
    '',
    formatReopenPlan(result.plan),
  ].join('\n');
}

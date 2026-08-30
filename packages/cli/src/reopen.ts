import fs from 'node:fs/promises';
import path from 'node:path';
import {
  formatReopenPlan,
  type InsertionMarker,
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

/**
 * Insertion markers for one work item, for the lifecycle timeline
 * (P6-SURFACE-04, FEAT-INS-015).
 *
 * Reads the records themselves rather than a mirror, because there is no
 * insertion table — contract 06 §3.5 puts them in `kanban/_insertions/` as
 * files, and inventing a table to make this convenient would put an audit
 * record somewhere `db:rebuild` could lose it.
 *
 * Scoped by **blast radius**, not by the card that raised it: an insertion
 * belongs on the timeline of every card it reached, which is the whole reason
 * the radius is recorded.
 */
export async function insertionMarkersFor(
  root: string,
  workItemId: string,
): Promise<readonly InsertionMarker[]> {
  const dir = path.join(resolveWorkspaceLayout(root).kanbanDir, INSERTIONS_DIR);
  const names = await fs.readdir(dir).catch(() => [] as string[]);

  const markers: InsertionMarker[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (raw === null) continue;

    const parsed = parseFrontmatter(raw);
    const radius = radiusFromRecord(parsed.body);
    if (!radius.includes(workItemId)) continue;

    const at = parsed.data['created_at'];
    markers.push({
      insertionId: name.replace(/\.md$/, ''),
      // The record's own timestamp, never the file's mtime: a checkout rewrites
      // mtimes and would move every marker to the moment somebody cloned.
      at: typeof at === 'string' ? at : '',
      summary:
        typeof parsed.data['summary'] === 'string'
          ? parsed.data['summary']
          : `insertion reaching ${workItemId}`,
    });
  }
  return markers;
}

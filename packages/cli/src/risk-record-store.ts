import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  resolveWorkspaceLayout,
  RISK_SEVERITY,
  blastRadiusRisks,
  riskRecordsFor,
  type RiskRecord,
  type SurfaceFinding,
} from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { nextSequence } from './commands.js';

/**
 * Writing the risk artifacts (P6-WRITEPATH-02).
 *
 * `sdlc risk` has been printing "2 risk card(s) to create:" since P2-SEC-03 and
 * nothing created them. This is the writer.
 *
 * **Idempotent on (work item, surface).** A risk scan runs many times over the
 * life of a change — every `advance`, every re-check — and a writer that appends
 * turns one payments risk into eleven identical records, which is how a risk
 * register becomes something people filter out. The key is the surface rather
 * than the file list, because adding a second payments file is the same risk
 * with more evidence, not a new one.
 *
 * **An existing record is never rewritten.** If someone has moved a risk to
 * `mitigated` and written why, a later scan finding the same surface must not
 * quietly reopen it — the scan knows what the diff touches and knows nothing
 * about what was done since. New evidence on a settled risk is a conversation,
 * not an overwrite.
 */

/** Beside `_inbox/` and `_insertions/` — contract 06's convention for records that are not work items. */
export const RISKS_DIRNAME = '_risks';

export interface RecordRisksResult {
  readonly created: readonly RiskRecord[];
  /** Surfaces already recorded for this work item, left exactly as they were. */
  readonly alreadyRecorded: readonly string[];
  readonly dir: string;
}

function render(record: RiskRecord): string {
  // A blast-radius record has no surface, so it has no entry in the
  // surface-keyed severity table either. The reason is stated here rather than
  // looked up, because the axis is the same one — how reversible the damage is —
  // and a `?? ''` would silently drop the sentence that makes the grade arguable.
  const because =
    record.surface === null
      ? 'two items writing one file is a merge somebody has to do: expensive, and recoverable'
      : RISK_SEVERITY[record.surface].because;
  const heading =
    record.surface === null
      ? `file-ownership risk on ${record.work_item_id}`
      : `${record.surface} risk on ${record.work_item_id}`;

  return [
    '---',
    `id: ${record.id}`,
    'kind: risk',
    `work_item_id: ${record.work_item_id}`,
    `source: ${record.source}`,
    `surface: ${record.surface ?? 'null'}`,
    `severity: ${record.severity}`,
    `status: ${record.status}`,
    'mitigation: null',
    'accepted_because: null',
    `created_at: ${record.created_at}`,
    '---',
    '',
    `# ${heading}`,
    '',
    `**Severity ${record.severity}** — ${because}.`,
    '',
    record.source === 'blast-radius' ? '## What collides' : '## What matched',
    '',
    ...record.evidence.map((item) => `- \`${item.path}\` — ${item.matched}`),
    '',
    '## Mitigation',
    '',
    // Deliberately a prompt, not a draft. An auto-generated mitigation is a
    // conclusion nobody reached, sitting where the person whose job it is to
    // reach one will read it as though somebody did.
    '_Not yet written._ Say what closes this, then set `status: mitigated`.',
    'If it is being accepted as-is, write why in `accepted_because` and set `status: accepted`.',
    '',
  ].join('\n');
}

/**
 * Risk keys already on disk for this work item.
 *
 * The key is `source:surface` (P6-WRITEPATH-02), not the surface alone. Every
 * blast-radius record has `surface: null`, so a surface-only key would let the
 * first one suppress every subsequent collision with a different item — and a
 * collision that is not recorded because a different collision already was is
 * the worst kind of duplicate suppression.
 */
async function existingSurfaces(dir: string, workItemId: string): Promise<Set<string>> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const surfaces = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    const data = parseFrontmatter(raw).data;
    if (data['work_item_id'] !== workItemId) continue;
    const source = typeof data['source'] === 'string' ? data['source'] : 'risk-surface';
    const surface = data['surface'];
    if (source === 'blast-radius') {
      // Keyed by who it collides with, which is what the evidence names.
      for (const line of raw.split('\n')) {
        const match = /also declared by ([A-Za-z0-9-]+)/.exec(line);
        if (match?.[1] !== undefined) surfaces.add(`blast-radius:${match[1]}`);
      }
    } else if (typeof surface === 'string') {
      surfaces.add(`risk-surface:${surface}`);
    }
  }
  return surfaces;
}

export async function recordRisks(
  root: string,
  workItemId: string,
  findings: readonly SurfaceFinding[],
  now: () => Date = () => new Date(),
  /**
   * File-ownership collisions from a blast-radius scan (P6-WRITEPATH-02).
   *
   * Optional and last, so every existing caller is unchanged. `overlap` findings
   * are deliberately not accepted here: overlap is common, usually fine, and a
   * card per overlap turns the risk directory into a place nobody looks.
   */
  collisions: readonly { readonly path: string; readonly withItem: string }[] = [],
): Promise<RecordRisksResult> {
  const layout = resolveWorkspaceLayout(root);
  const dir = path.join(layout.kanbanDir, RISKS_DIRNAME);
  await fs.mkdir(dir, { recursive: true });

  const already = await existingSurfaces(dir, workItemId);
  const fresh = findings.filter((finding) => !already.has(`risk-surface:${finding.surface}`));
  const alreadyRecorded = [...new Set(findings.map((f) => f.surface))].filter((surface) =>
    already.has(`risk-surface:${surface}`),
  );

  const timestamp = now().toISOString();
  let sequence = await nextSequence(layout.kanbanDir, 'RISK');
  const fromSurfaces = riskRecordsFor(fresh, workItemId, sequence, timestamp);
  sequence += fromSurfaces.length;

  // Blast-radius collisions, deduped against what is already on disk for the
  // same pair (P6-WRITEPATH-02). A second scan finding the same collision must
  // not file it twice — the record is a conversation to have, not a counter.
  const freshCollisions = collisions.filter(
    (collision) => !already.has(`blast-radius:${collision.withItem}`),
  );
  const created = [
    ...fromSurfaces,
    ...blastRadiusRisks(freshCollisions, workItemId, sequence, timestamp),
  ];

  for (const record of created) {
    // `wx`: two scans racing must not both write RISK-004. The filesystem is a
    // better arbiter than a re-read, and the loser failing loudly beats one
    // record silently becoming the other.
    await fs.writeFile(path.join(dir, `${record.id}.md`), render(record), {
      encoding: 'utf8',
      flag: 'wx',
    });
  }

  return { created, alreadyRecorded, dir: path.relative(layout.root, dir) };
}

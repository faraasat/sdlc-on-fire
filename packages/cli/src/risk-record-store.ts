import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  resolveWorkspaceLayout,
  RISK_SEVERITY,
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
  const grade = RISK_SEVERITY[record.surface];
  return [
    '---',
    `id: ${record.id}`,
    'kind: risk',
    `work_item_id: ${record.work_item_id}`,
    `surface: ${record.surface}`,
    `severity: ${record.severity}`,
    `status: ${record.status}`,
    'mitigation: null',
    'accepted_because: null',
    `created_at: ${record.created_at}`,
    '---',
    '',
    `# ${record.surface} risk on ${record.work_item_id}`,
    '',
    `**Severity ${record.severity}** — ${grade.because}.`,
    '',
    '## What matched',
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

/** Surfaces already on disk for this work item. */
async function existingSurfaces(dir: string, workItemId: string): Promise<Set<string>> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const surfaces = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '');
    const data = parseFrontmatter(raw).data;
    if (data['work_item_id'] !== workItemId) continue;
    const surface = data['surface'];
    if (typeof surface === 'string') surfaces.add(surface);
  }
  return surfaces;
}

export async function recordRisks(
  root: string,
  workItemId: string,
  findings: readonly SurfaceFinding[],
  now: () => Date = () => new Date(),
): Promise<RecordRisksResult> {
  const layout = resolveWorkspaceLayout(root);
  const dir = path.join(layout.kanbanDir, RISKS_DIRNAME);
  await fs.mkdir(dir, { recursive: true });

  const already = await existingSurfaces(dir, workItemId);
  const fresh = findings.filter((finding) => !already.has(finding.surface));
  const alreadyRecorded = [...new Set(findings.map((f) => f.surface))].filter((surface) =>
    already.has(surface),
  );

  const created = riskRecordsFor(
    fresh,
    workItemId,
    await nextSequence(layout.kanbanDir, 'RISK'),
    now().toISOString(),
  );

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

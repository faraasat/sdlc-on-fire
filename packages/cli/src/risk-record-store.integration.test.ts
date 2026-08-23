import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectRiskSurfaces, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { afterEach, describe, expect, it } from 'vitest';
import { recordRisks, RISKS_DIRNAME } from './risk-record-store.js';

/**
 * Writing the risk artifacts (P6-WRITEPATH-02).
 *
 * Against a real directory rather than a mocked filesystem: the properties that
 * matter here — idempotence across runs, refusing to overwrite, where the file
 * actually lands — are properties of the filesystem, and a mock would only prove
 * the mock agrees with my model of it.
 */
const dirs: string[] = [];
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-risk-'));
  dirs.push(root);
  await fs.mkdir(resolveWorkspaceLayout(root).kanbanDir, { recursive: true });
  return root;
}

const AUTH = detectRiskSurfaces([
  { path: 'src/auth.ts', addedContent: 'const t = 1;' },
  { path: 'src/session.ts', addedContent: 'const s = 1;' },
]);
const PAYMENTS = detectRiskSurfaces([{ path: 'src/payments/charge.ts', addedContent: 'x' }]);

describe('recordRisks', () => {
  it('writes one file per surface, under the kanban record folder', async () => {
    const root = await workspace();
    const result = await recordRisks(root, 'FEAT-001', AUTH);

    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.surface).toBe('auth');
    expect(result.dir.endsWith(RISKS_DIRNAME)).toBe(true);

    const file = path.join(resolveWorkspaceLayout(root).kanbanDir, RISKS_DIRNAME, 'RISK-001.md');
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('work_item_id: FEAT-001');
    expect(text).toContain('status: open');
    // Both files that matched, so the record can be argued with.
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('src/session.ts');
    // And no drafted conclusion.
    expect(text).toContain('_Not yet written._');
  });

  it('is idempotent across runs', async () => {
    // A scan runs on every advance. A writer that appended would turn one
    // payments risk into eleven identical records, which is how a register
    // becomes something people filter out.
    const root = await workspace();
    await recordRisks(root, 'FEAT-001', AUTH);
    const second = await recordRisks(root, 'FEAT-001', AUTH);

    expect(second.created).toEqual([]);
    expect(second.alreadyRecorded).toEqual(['auth']);
    const files = await fs.readdir(
      path.join(resolveWorkspaceLayout(root).kanbanDir, RISKS_DIRNAME),
    );
    expect(files).toEqual(['RISK-001.md']);
  });

  it('never rewrites a record somebody has settled', async () => {
    // The scan knows what the diff touches and knows nothing about what was done
    // since. Quietly reopening a mitigated risk would erase the only record that
    // it was handled.
    const root = await workspace();
    await recordRisks(root, 'FEAT-001', AUTH);
    const file = path.join(resolveWorkspaceLayout(root).kanbanDir, RISKS_DIRNAME, 'RISK-001.md');
    const settled = (await fs.readFile(file, 'utf8'))
      .replace('status: open', 'status: mitigated')
      .replace('mitigation: null', 'mitigation: moved behind the session guard');
    await fs.writeFile(file, settled, 'utf8');

    await recordRisks(root, 'FEAT-001', AUTH);
    expect(await fs.readFile(file, 'utf8')).toContain('status: mitigated');
  });

  it('keys on the surface, not on the work item alone', async () => {
    // A second surface on the same card is a second risk. Keying on the card
    // would record the first one and silently drop every one after it.
    const root = await workspace();
    await recordRisks(root, 'FEAT-001', AUTH);
    const second = await recordRisks(root, 'FEAT-001', PAYMENTS);
    expect(second.created.map((r) => r.surface)).toEqual(['payments']);
    expect(second.created[0]?.id).toBe('RISK-002');
  });

  it('records the same surface separately for a different work item', async () => {
    // Two cards touching auth are two risks. Deduplicating across cards would
    // make the second card's risk invisible because the first one had it.
    const root = await workspace();
    await recordRisks(root, 'FEAT-001', AUTH);
    const other = await recordRisks(root, 'FEAT-002', AUTH);
    expect(other.created).toHaveLength(1);
    expect(other.created[0]?.work_item_id).toBe('FEAT-002');
  });

  /*
   * There was a test here for the `wx` flag. It passed with `wx` and passed
   * without it, because two `recordRisks` calls in one process do not actually
   * collide: the second reads the sequence after the first has written, and the
   * clash never happens. A test that passes under the mutation it was written to
   * catch is not coverage, it is the appearance of coverage — the same defect as
   * the seeded-with-the-wrong-key etag test found in P5-TRACK-01.
   *
   * `wx` stays. The race it guards is two `sdlc advance` processes, which no
   * in-process test can stage, and the cost of being wrong is one work item's
   * risk record silently becoming another's. Recorded as a knowing mutation
   * survivor rather than tested around.
   */
  it('writes nothing when nothing was found', async () => {
    const root = await workspace();
    const result = await recordRisks(root, 'FEAT-001', []);
    expect(result.created).toEqual([]);
  });
});

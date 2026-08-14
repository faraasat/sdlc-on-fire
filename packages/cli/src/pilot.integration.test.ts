import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PILOT_CRITERIA } from '@sdlc-on-fire/core';
import { checkPilot, PILOT_REPORT, writePilotTemplate } from './pilot.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/** `sdlc pilot` against a real workspace (P2-QA-07, ADR-0064). */

const dirs: string[] = [];

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-pilot-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, relative), content, 'utf8');
  }
  return root;
}

const passing = JSON.stringify({
  repository: 'github.com/someone/ordinary-app',
  maintainer: 'someone',
  observations: PILOT_CRITERIA.map((criterion) => ({
    criterion,
    kind: 'command-output',
    detail: 'recorded output',
    atCommit: 'abc1234',
  })),
  friction: [{ summary: 'init asked twice', workItemId: 'BUG-014' }],
});

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('checkPilot', () => {
  it('refuses when no report exists at all', async () => {
    // Absent is a refusal, not an absence of opinion: no report means the pilot
    // has not happened, and the release it gates stays blocked.
    const result = await checkPilot(await workspace());
    expect(result.ok).toBe(false);
    expect(result.verdict.findings[0]?.message).toContain('has not happened');
  });

  it('passes a report that measured everything on one commit', async () => {
    expect((await checkPilot(await workspace({ [PILOT_REPORT]: passing }))).ok).toBe(true);
  });
});

describe('writePilotTemplate', () => {
  it('writes a skeleton that fails its own check', async () => {
    // The property worth pinning, and the same one `sdlc research new` has: a
    // template whose output satisfies the gate has produced a pass.
    const root = await workspace();
    expect((await writePilotTemplate(root)).created).toBe(true);
    expect((await checkPilot(root)).ok).toBe(false);
  });

  it('leaves every observation marked as an assertion', async () => {
    // The skeleton must be honest about itself, not merely fail for some other
    // reason. Pre-marking the rows `command-output` would leave the template
    // failing on its empty repository field alone — and the first person to
    // fill that in would have a report claiming four measurements nobody made.
    const root = await workspace();
    await writePilotTemplate(root);
    const written = JSON.parse(await fs.readFile(path.join(root, PILOT_REPORT), 'utf8')) as {
      observations: { kind: string }[];
    };
    expect(written.observations.every((entry) => entry.kind === 'assertion')).toBe(true);
  });

  it('never overwrites a report that is already there', async () => {
    // It may hold a real pilot's evidence.
    const root = await workspace({ [PILOT_REPORT]: passing });
    expect((await writePilotTemplate(root)).created).toBe(false);
    expect((await checkPilot(root)).ok).toBe(true);
  });
});

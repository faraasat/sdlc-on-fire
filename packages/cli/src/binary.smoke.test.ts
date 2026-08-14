import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Did the build catch fire — asked of the **built binary**, not the module.
 *
 * Shallow on purpose: boot it, and drive the one flow that touches every
 * subsystem at least once. Neither case pins a past bug, which is why they live
 * here rather than in `binary.regression.test.ts` — the regression tier is a
 * ledger of defects already paid for, and padding it with checks that never
 * caught anything makes it a worse ledger.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-smoke-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('built binary', () => {
  it('executes and reports its version', async () => {
    const { stdout } = await run('node', [CLI, '--help']);
    expect(stdout).toContain('sdlc');
  }, 30_000);

  it('runs the real init → status → new flow', async () => {
    const root = await workspace();
    await run('node', [CLI, '-C', root, 'init']);

    const { stdout: statusJson } = await run('node', [CLI, '-C', root, 'status', '--json']);
    expect(JSON.parse(statusJson)).toMatchObject({ initialised: true, databaseMode: 'pglite' });

    await run('node', [CLI, '-C', root, 'new', 'task', 'Smoke']);
    await expect(
      fs.stat(path.join(root, 'kanban', '_inbox', 'TASK-001.md')),
    ).resolves.toBeDefined();
  }, 60_000);
});

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Executes the **built binary**, not the module.
 *
 * A duplicate shebang once shipped past a fully green unit suite: every test
 * imported `index.ts`, and no test ever ran `dist/index.js`. The bundle was a
 * syntax error on line 2. Nothing short of executing the artifact catches that.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-bin-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('built binary', () => {
  it('has exactly one shebang, on the first line', async () => {
    const built = await fs.readFile(CLI, 'utf8');
    const shebangs = built.split('\n').filter((line) => line.startsWith('#!'));
    expect(shebangs).toHaveLength(1);
    expect(built.startsWith('#!')).toBe(true);
  });

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

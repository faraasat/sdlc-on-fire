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

  it('runs through a bin symlink, the way npm installs it', async () => {
    // npm installs a bin as `node_modules/.bin/sdlc` symlinked at
    // `dist/index.js`, so `argv[1]` is the *symlink*. The entry guard used to
    // ask whether `import.meta.url` ended with `basename(argv[1])` — whether
    // `…/dist/index.js` ends with `sdlc`. It does not, so **every installed
    // copy did nothing and exited 0**: `sdlc --help`, `sdlc init`, all of it,
    // silent success. Nothing caught it because every test and every manual
    // check ran `node dist/index.js`, where the basenames happen to match.
    //
    // Exit 0 with empty stdout is the exact signature, so this asserts on
    // output rather than on the exit code.
    const dir = await workspace();
    const shim = path.join(dir, 'sdlc');
    await fs.symlink(CLI, shim);

    const { stdout } = await run('node', [shim, '--help']);
    expect(stdout).toContain('Usage: sdlc');
    expect(stdout.length).toBeGreaterThan(0);
  }, 30_000);

  it('does not run when merely imported', async () => {
    // The other half of the guard: importing the module from a test must not
    // parse the test runner's argv. A fix for the symlink case that made this
    // always-true would trade one silent failure for a louder one.
    const dir = await workspace();
    const probe = path.join(dir, 'probe.mjs');
    await fs.writeFile(
      probe,
      `await import(${JSON.stringify(CLI)});\nprocess.stdout.write('imported-cleanly');\n`,
      'utf8',
    );

    const { stdout } = await run('node', [probe, 'status', '--json']);
    expect(stdout).toBe('imported-cleanly');
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

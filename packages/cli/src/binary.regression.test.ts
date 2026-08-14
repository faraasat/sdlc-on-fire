import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Bugs the built binary already shipped once, pinned so they cannot return.
 *
 * Every case here is a defect that reached `dist/index.js` past a fully green
 * unit suite: every test imported `index.ts`, and no test ever ran the artifact.
 * Nothing short of executing it catches that class of failure, and nothing short
 * of a permanent case keeps it caught.
 *
 * The boot checks that pin nothing live in `binary.smoke.test.ts`.
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
      // A file URL, not a path. `import('C:\\…')` reads `C:` as a URL scheme
      // and throws ERR_UNSUPPORTED_ESM_URL_SCHEME, which would fail this test
      // for a reason that has nothing to do with the guard it is pinning.
      `await import(${JSON.stringify(pathToFileURL(CLI).href)});\nprocess.stdout.write('imported-cleanly');\n`,
      'utf8',
    );

    const { stdout } = await run('node', [probe, 'status', '--json']);
    expect(stdout).toBe('imported-cleanly');
  }, 30_000);
});

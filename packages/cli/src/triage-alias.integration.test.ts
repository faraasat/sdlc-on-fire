import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';

/**
 * P5-PILOT-03 — `--as` and `--type` are one argument (from the hono pilot).
 *
 * The on-disk frontmatter field is `type`, so somebody who has read a card
 * reaches for `--type` and gets `unknown option`. That is exactly how the pilot
 * operator hit it. These run the built binary, because the defect was in the
 * argument parser and a unit test of the handler cannot see it.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-triage-'));
  await init(root, { database: 'skip' });
  await run(process.execPath, [CLI, 'capture', 'something worth doing'], { cwd: root });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc triage', () => {
  it('accepts --as', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'triage', 'CAP-001', '--as', 'feature'], {
      cwd: root,
    });
    expect(stdout).toContain('(feature)');
  }, 60_000);

  it('accepts --type, the name on the card', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'triage', 'CAP-001', '--type', 'bug'], {
      cwd: root,
    });
    expect(stdout).toContain('(bug)');
  }, 60_000);

  it('names the flag when neither is given, rather than saying "required option"', async () => {
    await expect(
      run(process.execPath, [CLI, 'triage', 'CAP-001'], { cwd: root }),
    ).rejects.toMatchObject({ code: 2 });
  }, 60_000);

  it('refuses two spellings that disagree instead of silently picking one', async () => {
    // Picking either would do something the user did not ask for.
    await expect(
      run(process.execPath, [CLI, 'triage', 'CAP-001', '--as', 'bug', '--type', 'feature'], {
        cwd: root,
      }),
    ).rejects.toMatchObject({ code: 2 });
  }, 60_000);

  it('allows two spellings that agree', async () => {
    const { stdout } = await run(
      process.execPath,
      [CLI, 'triage', 'CAP-001', '--as', 'task', '--type', 'task'],
      { cwd: root },
    );
    expect(stdout).toContain('(task)');
  }, 60_000);
});

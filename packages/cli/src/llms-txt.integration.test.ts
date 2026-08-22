import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { llmsTxt } from './docs-check.js';

/**
 * `sdlc llms-txt` against a real workspace (P4-DOC-02).
 *
 * The compiler is pure and tested in core. What only this can show is that
 * `--check` does not write — the first version obtained its expected contents by
 * calling the writing path, so it wrote the file it was verifying and compared
 * it against itself. It could not fail, and nothing but a test that inspects the
 * file afterwards distinguishes that from a check that works.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-llms-'));
  await init(root, { database: 'skip' });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('sdlc llms-txt', () => {
  it('writes an index built from the real docs directory', async () => {
    const result = await llmsTxt(root, { write: true });
    expect(result.written).toBe(true);
    expect(result.docs).toBeGreaterThan(0);

    const written = await fs.readFile(path.join(root, 'llms.txt'), 'utf8');
    expect(written.startsWith('# ')).toBe(true);
    expect(written).toContain('## ');
  });

  it('does not write when only checking', async () => {
    // The defect the first version had: `--check` wrote the file it verified.
    const before = await exists(path.join(root, 'llms.txt'));
    expect(before).toBe(false);

    const result = await llmsTxt(root, {});
    expect(result.written).toBe(false);
    expect(await exists(path.join(root, 'llms.txt'))).toBe(false);
  });

  it('reports out-of-date when the committed file does not match', async () => {
    await llmsTxt(root, { write: true });
    await fs.writeFile(path.join(root, 'llms.txt'), '# stale\n');
    expect((await llmsTxt(root, {})).upToDate).toBe(false);
  });

  it('reports up-to-date immediately after writing', async () => {
    await llmsTxt(root, { write: true });
    expect((await llmsTxt(root, {})).upToDate).toBe(true);
  });

  it('notices a doc added after the last compile', async () => {
    await llmsTxt(root, { write: true });
    await fs.writeFile(path.join(root, 'docs', 'new-page.md'), '# A newly added page\n\nbody\n');
    expect((await llmsTxt(root, {})).upToDate).toBe(false);
  });

  it('is stable across runs, so committing it does not churn', async () => {
    const a = await llmsTxt(root, {});
    const b = await llmsTxt(root, {});
    expect(a.contents).toBe(b.contents);
  });

  it('exits non-zero on the built binary when --check finds drift', async () => {
    await run(process.execPath, [CLI, 'llms-txt'], { cwd: root });
    await fs.writeFile(path.join(root, 'llms.txt'), '# stale\n');
    await expect(
      run(process.execPath, [CLI, 'llms-txt', '--check'], { cwd: root }),
    ).rejects.toMatchObject({ code: 1 });
  }, 60_000);

  it('exits zero on the built binary when --check finds it current', async () => {
    await run(process.execPath, [CLI, 'llms-txt'], { cwd: root });
    const { stdout } = await run(process.execPath, [CLI, 'llms-txt', '--check'], { cwd: root });
    expect(stdout).toContain('up to date');
  }, 60_000);
});

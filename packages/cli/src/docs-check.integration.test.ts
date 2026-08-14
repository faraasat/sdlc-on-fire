import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDocs, readDocs } from './docs-check.js';
import { init } from './commands.js';

/** P1-DOC-01 end to end, against a real git repo. */

const run = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-docs-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'src', 'importer'), { recursive: true });
}, 60_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, body: string) => fs.writeFile(path.join(root, rel), body, 'utf8');

const commit = async (message: string) => {
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-q', '-m', message], { cwd: root });
};

describe('readDocs', () => {
  it('reads covers and refresh_by from the doc itself', async () => {
    await write(
      'docs/importer.md',
      '---\ncovers:\n  - "src/importer/**"\nrefresh_by: "2027-01-01"\n---\n\n# Importer\n',
    );
    const docs = await readDocs(root);
    const doc = docs.find((entry) => entry.path === 'docs/importer.md');
    // A doc that moves takes its declaration with it; a central manifest would
    // go stale in exactly the way this check exists to find.
    expect(doc?.covers).toEqual(['src/importer/**']);
    expect(doc?.refreshBy).toBe('2027-01-01');
  }, 60_000);

  it('resolves relative links and marks the missing ones', async () => {
    await write('docs/a.md', '# A\n\nSee [b](b.md) and [gone](gone.md).\n');
    await write('docs/b.md', '# B\n');
    const doc = (await readDocs(root)).find((entry) => entry.path === 'docs/a.md');
    expect(doc?.links).toEqual([
      { target: 'b.md', resolves: true },
      { target: 'gone.md', resolves: false },
    ]);
  }, 60_000);
});

describe('checkDocs', () => {
  it('advises when covered code changed and the doc did not', async () => {
    await write('docs/importer.md', '---\ncovers:\n  - "src/importer/**"\n---\n\n# Importer\n');
    await write('src/importer/csv.ts', 'export const a = 1;\n');
    await commit('first');
    await write('src/importer/csv.ts', 'export const a = 2;\n');
    await commit('changed the code only');

    const result = await checkDocs(root, 'HEAD~1');
    expect(result.report.advisory.map((f) => f.kind)).toContain('code-changed-doc-did-not');
    // Advisory: plenty of code changes do not affect what a doc says.
    expect(result.report.ok).toBe(true);
  }, 60_000);

  it('fails on a broken link', async () => {
    await write('docs/a.md', '# A\n\nSee [gone](gone.md).\n');
    await commit('first');

    const result = await checkDocs(root, 'HEAD');
    expect(result.report.ok).toBe(false);
  }, 60_000);

  it('reports nothing on a range git cannot resolve', async () => {
    await write('docs/importer.md', '---\ncovers:\n  - "src/importer/**"\n---\n\n# Importer\n');
    await write('src/importer/csv.ts', 'export const a = 1;\n');
    await commit('only commit');

    // Reporting "everything changed" here would fire every finding on a first
    // run, which is how a check teaches people to ignore it.
    const result = await checkDocs(root, 'HEAD~5');
    expect(result.report.advisory).toEqual([]);
  }, 60_000);
});

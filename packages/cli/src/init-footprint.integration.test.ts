import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ESSENTIAL_ROOT_FILES } from '@sdlc-on-fire/core';
import { init } from './commands.js';

/**
 * P5-PILOT-02 — how much `init` adds to a repository that already has its own
 * conventions.
 *
 * From the hono pilot: 28 files, seven at the root and twenty-one into a
 * curated `docs/` that had three. Nothing was overwritten — the non-destructive
 * invariant held — and it is still a large front door for one tool, in exactly
 * the moment a maintainer is deciding whether to keep it.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-footprint-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

/** Make the directory look like a project that documents itself. */
async function withOwnConventions(): Promise<void> {
  await fs.writeFile(path.join(root, 'README.md'), '# their project\n');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'CONTRIBUTING.md'), '# how to contribute\n');
}

const rootMarkdown = async (): Promise<string[]> =>
  (await fs.readdir(root)).filter((entry) => /^[A-Z][A-Z_]*\.md$/.test(entry)).sort();

describe('init footprint', () => {
  it('scaffolds the full set in an empty directory, where there is no convention to intrude on', async () => {
    await init(root, { database: 'skip' });
    expect((await rootMarkdown()).length).toBeGreaterThan(ESSENTIAL_ROOT_FILES.length);
  }, 60_000);

  it('scaffolds only the essentials in a repo that already documents itself', async () => {
    await withOwnConventions();
    await init(root, { database: 'skip' });

    const files = await rootMarkdown();
    // README.md is theirs and predates us; the rest must be exactly the three
    // the product needs in order to operate.
    expect(files.filter((f) => f !== 'README.md').sort()).toEqual([...ESSENTIAL_ROOT_FILES].sort());
  }, 60_000);

  it('adds no documents to a docs/ directory somebody curated', async () => {
    await withOwnConventions();
    await init(root, { database: 'skip' });

    const docs = (await fs.readdir(path.join(root, 'docs'))).filter((e) => e.endsWith('.md'));
    // Only their file. The subdirectory indexes are structure, not documents.
    expect(docs).toEqual(['CONTRIBUTING.md']);
  }, 60_000);

  it('still never overwrites their file', async () => {
    // The invariant that already held on the pilot, kept under the new path.
    await withOwnConventions();
    await init(root, { database: 'skip' });
    expect(await fs.readFile(path.join(root, 'docs', 'CONTRIBUTING.md'), 'utf8')).toBe(
      '# how to contribute\n',
    );
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# their project\n');
  }, 60_000);

  it('needs both signals before it decides a repo has conventions', async () => {
    // A README alone is nearly universal and says nothing about whether the
    // project has decided how it documents itself.
    //
    // The README they wrote is excluded from the count. Including it made this
    // assertion 4 > 3 and it held even when the detection was reduced to
    // "has a README" — passing while testing nothing.
    await fs.writeFile(path.join(root, 'README.md'), '# just a readme\n');
    await init(root, { database: 'skip' });
    const ours = (await rootMarkdown()).filter((file) => file !== 'README.md');
    expect(ours.length).toBeGreaterThan(ESSENTIAL_ROOT_FILES.length);
  }, 60_000);

  it('honours --full over the detection', async () => {
    // A maintainer disagreeing with our guess about their own repository should
    // not have to work around it.
    await withOwnConventions();
    await init(root, { database: 'skip', scaffold: 'full' });
    expect((await rootMarkdown()).length).toBeGreaterThan(ESSENTIAL_ROOT_FILES.length);
  }, 60_000);

  it('honours --minimal over the detection', async () => {
    await init(root, { database: 'skip', scaffold: 'minimal' });
    expect((await rootMarkdown()).sort()).toEqual([...ESSENTIAL_ROOT_FILES].sort());
  }, 60_000);

  it('leaves the workspace operable either way', async () => {
    // The point of the essentials list: what remains must still work.
    await withOwnConventions();
    const result = await init(root, { database: 'skip' });
    expect(result.created.length).toBeGreaterThan(0);
    for (const file of ESSENTIAL_ROOT_FILES) {
      await expect(fs.access(path.join(root, file))).resolves.toBeUndefined();
    }
    await expect(fs.access(path.join(root, 'kanban'))).resolves.toBeUndefined();
  }, 60_000);
});

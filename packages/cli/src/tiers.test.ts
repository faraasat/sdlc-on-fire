import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverTiers, formatTiers, reportTiers } from './tiers.js';

/**
 * `sdlc tiers` (P2-QA-01).
 *
 * Real directory trees. What is under test is discovery from the filesystem —
 * whether a tier exists as *files* — which is the question `evaluateTiers`
 * structurally cannot answer: a repository with no integration tests never
 * produces an integration run to be missing, so the absence has to be found by
 * looking at the tree.
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tree(files: readonly string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiers-'));
  dirs.push(root);
  for (const rel of files) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, '// test\n', 'utf8');
  }
  return root;
}

describe('discoverTiers', () => {
  it('groups real files by tier', async () => {
    const root = await tree([
      'src/a.test.ts',
      'src/b.test.ts',
      'src/db.integration.test.ts',
      'src/boot.smoke.test.ts',
    ]);
    const found = await discoverTiers(root);
    expect(found.map((t) => [t.tier, t.files.length])).toEqual([
      ['integration', 1],
      ['smoke', 1],
      ['unit', 2],
    ]);
  });

  it('ignores non-test files', async () => {
    const root = await tree(['src/index.ts', 'README.md', 'src/a.test.ts']);
    expect(await discoverTiers(root)).toEqual([{ tier: 'unit', files: ['src/a.test.ts'] }]);
  });

  it('does not walk node_modules', async () => {
    // A dependency's own test files would otherwise report tiers this
    // repository has not written — the loudest possible false pass.
    const root = await tree(['node_modules/dep/x.integration.test.ts', 'src/a.test.ts']);
    const found = await discoverTiers(root);
    expect(found.map((t) => t.tier)).toEqual(['unit']);
  });

  it('skips build output as well as dependencies', async () => {
    const root = await tree(['dist/a.test.js', 'coverage/b.test.js', 'src/a.test.ts']);
    expect((await discoverTiers(root)).map((t) => t.tier)).toEqual(['unit']);
  });

  it('finds nothing in a tree with no tests', async () => {
    expect(await discoverTiers(await tree(['src/index.ts']))).toEqual([]);
  });
});

describe('reportTiers', () => {
  it('names required tiers the repository has no files for', async () => {
    // The reason this command exists. `evaluateTiers` reports on runs it was
    // handed; a repository with no integration tests never produces a run to be
    // missing, so the runner matches nothing, exits 0, and the tier looks fine.
    const result = await reportTiers(await tree(['src/a.test.ts']), 'standard');
    expect(result.unwritten).toEqual(['integration', 'regression']);
    expect(result.report.satisfied).toBe(false);
  });

  it('is never satisfied by files alone, however complete the set', async () => {
    // This used to assert `satisfied === true`, and its own name said why that
    // was wrong: "satisfied when every required tier has *files*". Discovery
    // walks a directory; nothing was run, and a command that reports a
    // requirement met on the strength of filenames is making the claim this
    // product exists to refuse. Found by running the binary against an
    // unrelated repository, where it printed "85/85 unit tests passed" for a
    // suite it had never executed (P2-QA-07).
    const root = await tree([
      'src/a.test.ts',
      'src/b.integration.test.ts',
      'src/c.regression.test.ts',
    ]);
    const result = await reportTiers(root, 'standard');
    expect(result.unwritten).toEqual([]);
    expect(result.report.satisfied).toBe(false);
    expect(result.report.findings.every((finding) => finding.status === 'present')).toBe(true);
  });

  it('holds a lite repository to a lite bar', async () => {
    // The bar being lower shows up as nothing *unwritten*, not as a pass.
    const result = await reportTiers(await tree(['src/a.test.ts']), 'lite');
    expect(result.unwritten).toEqual([]);
    expect(result.report.satisfied).toBe(false);
  });

  it('asks strict for e2e and smoke as well', async () => {
    const root = await tree([
      'src/a.test.ts',
      'src/b.integration.test.ts',
      'src/c.regression.test.ts',
    ]);
    const result = await reportTiers(root, 'strict');
    expect(result.unwritten).toEqual(['smoke', 'e2e']);
  });

  it('reports a tier that ran without being required, without complaining', async () => {
    const root = await tree([
      'src/a.test.ts',
      'src/b.integration.test.ts',
      'src/c.regression.test.ts',
      'src/d.e2e.test.ts',
    ]);
    const result = await reportTiers(root, 'standard');
    expect(result.extra).toEqual(['e2e']);
  });

  it('says plainly that an empty tier is not a passing tier', async () => {
    const text = formatTiers(await reportTiers(await tree(['src/a.test.ts']), 'standard'));
    expect(text).toContain('no files at all');
    expect(text).toContain('looks exactly like success');
  });
});

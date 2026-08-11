import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLicenses, formatLicenses, installedPackages } from './licenses.js';

/**
 * `sdlc deps licenses` (P2-SEC-08).
 *
 * Runs against real `node_modules` trees on disk. The behaviour under test is
 * where files are and how npm has spelled `license` over the years, neither of
 * which a mock would exercise.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function project(
  own: Record<string, unknown>,
  installed: Record<string, Record<string, unknown>>,
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lic-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(own), 'utf8');

  for (const [name, manifest] of Object.entries(installed)) {
    const dir = path.join(root, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
  }
  return root;
}

describe('installedPackages', () => {
  it('reads scoped and unscoped packages', async () => {
    const root = await project(
      { name: 'app', license: 'MIT' },
      {
        lodash: { name: 'lodash', license: 'MIT' },
        '@scope/thing': { name: '@scope/thing', license: 'Apache-2.0' },
      },
    );
    const found = await installedPackages(root);
    expect(found.map((p) => p.name).sort()).toEqual(['@scope/thing', 'lodash']);
  });

  it('reads the deprecated object and array forms', async () => {
    const root = await project(
      { name: 'app' },
      {
        old: { name: 'old', license: { type: 'MIT' } },
        older: { name: 'older', licenses: [{ type: 'MIT' }, { type: 'GPL-3.0' }] },
      },
    );
    const found = await installedPackages(root);
    expect(found.find((p) => p.name === 'old')?.license).toBe('MIT');
    // The array form was a *choice* of licenses, so it joins with OR — reading
    // it as a conjunction would flag dual-licensed packages a project may
    // legitimately take the permissive side of.
    expect(found.find((p) => p.name === 'older')?.license).toBe('MIT OR GPL-3.0');
  });

  it('finds a nested dependency that did not hoist', async () => {
    const root = await project({ name: 'app' }, { outer: { name: 'outer', license: 'MIT' } });
    const nested = path.join(root, 'node_modules', 'outer', 'node_modules', 'inner');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(nested, 'package.json'),
      JSON.stringify({ name: 'inner', license: 'AGPL-3.0' }),
      'utf8',
    );

    const found = await installedPackages(root);
    // A scan that only reads the top level reports on whatever happened to
    // hoist, which is not a property anyone chose.
    expect(found.map((p) => p.name)).toContain('inner');
  });

  it('follows a symlinked package', async () => {
    const root = await project({ name: 'app' }, {});
    const store = path.join(root, '.store', 'dep');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(
      path.join(store, 'package.json'),
      JSON.stringify({ name: 'dep', license: 'AGPL-3.0' }),
      'utf8',
    );
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
    await fs.symlink(store, path.join(root, 'node_modules', 'dep'), 'dir');

    // `Dirent.isDirectory()` is false for a symlink whatever it points at.
    // Filtering on it alone made this command report "no installed packages"
    // for an entire pnpm monorepo — the layout of this repo, and of most
    // projects it will run against.
    const found = await installedPackages(root);
    expect(found.map((p) => p.name)).toEqual(['dep']);
  });

  it('reads the pnpm store, not only the direct dependencies', async () => {
    const root = await project({ name: 'app' }, {});
    const modules = path.join(root, 'node_modules');

    // The real pnpm shape: `.pnpm/<name>@<version>/node_modules/<name>`, with
    // the top level holding symlinks to direct dependencies only.
    for (const [key, manifest] of [
      ['direct@1.0.0', { name: 'direct', license: 'MIT' }],
      ['transitive@2.0.0', { name: 'transitive', license: 'GPL-3.0' }],
    ] as const) {
      const dir = path.join(modules, '.pnpm', key, 'node_modules', manifest.name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest), 'utf8');
    }
    await fs.symlink(
      path.join(modules, '.pnpm', 'direct@1.0.0', 'node_modules', 'direct'),
      path.join(modules, 'direct'),
      'dir',
    );

    const found = await installedPackages(root);
    // A GPL package pulled in three levels down is exactly the one that
    // surprises a team, because nobody chose it.
    expect(found.map((p) => p.name).sort()).toEqual(['direct', 'transitive']);
  });

  it('does not walk the same real package twice', async () => {
    const root = await project({ name: 'app' }, {});
    const store = path.join(root, '.store', 'shared');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(
      path.join(store, 'package.json'),
      JSON.stringify({ name: 'shared', license: 'MIT' }),
      'utf8',
    );
    const modules = path.join(root, 'node_modules');
    await fs.mkdir(modules, { recursive: true });
    await fs.symlink(store, path.join(modules, 'a'), 'dir');
    await fs.symlink(store, path.join(modules, 'b'), 'dir');

    // A symlinked store makes the tree a graph: two dependents on one version
    // link to one directory. Reporting it twice would inflate every count.
    const found = await installedPackages(root);
    expect(found.filter((p) => p.name === 'shared')).toHaveLength(1);
  });

  it('ignores a dangling symlink rather than throwing', async () => {
    const root = await project({ name: 'app' }, { real: { name: 'real', license: 'MIT' } });
    await fs.symlink(path.join(root, 'nowhere'), path.join(root, 'node_modules', 'broken'), 'dir');

    // Asserts the observable property — no throw, no phantom package — and not
    // the `stat` guard specifically: with the guard inverted, a dangling link
    // is admitted, finds no manifest, and recurses into nothing, producing the
    // same result. The guard is there to skip pointless work, not to change
    // the answer, and this test does not pretend otherwise.
    expect((await installedPackages(root)).map((p) => p.name)).toEqual(['real']);
  });

  it('returns nothing rather than throwing when nothing is installed', async () => {
    const root = await project({ name: 'app' }, {});
    expect(await installedPackages(root)).toEqual([]);
  });

  it('survives a malformed manifest', async () => {
    const root = await project({ name: 'app' }, { good: { name: 'good', license: 'MIT' } });
    const bad = path.join(root, 'node_modules', 'bad');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'package.json'), '{{{ not json', 'utf8');

    const found = await installedPackages(root);
    expect(found.map((p) => p.name)).toEqual(['good']);
  });
});

describe('checkLicenses', () => {
  it('flags a copyleft dependency in an MIT project', async () => {
    const root = await project(
      { name: 'app', license: 'MIT' },
      { fine: { name: 'fine', license: 'MIT' }, risky: { name: 'risky', license: 'AGPL-3.0' } },
    );
    const result = await checkLicenses(root);
    expect(result.gate.decision).toBe('needs-human');
    expect(result.gate.flagged.map((f) => f.name)).toEqual(['risky']);
  });

  it('takes the project’s own license from its package.json', async () => {
    const root = await project(
      { name: 'app', license: 'GPL-3.0' },
      { dep: { name: 'dep', license: 'GPL-3.0' } },
    );
    const result = await checkLicenses(root);
    expect(result.projectLicense).toBe('GPL-3.0');
    expect(result.gate.decision).toBe('clean');
  });

  it('counts a package present at two versions once', async () => {
    const root = await project({ name: 'app' }, { a: { name: 'dup', license: 'MIT' } });
    const nested = path.join(root, 'node_modules', 'a', 'node_modules', 'b');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(nested, 'package.json'),
      JSON.stringify({ name: 'dup', license: 'MIT' }),
      'utf8',
    );
    const result = await checkLicenses(root);
    // One licensing question, not two.
    expect(result.packagesFound).toBe(1);
  });

  it('defaults to MIT when the project declares nothing', async () => {
    const root = await project({ name: 'app' }, { dep: { name: 'dep', license: 'MIT' } });
    expect((await checkLicenses(root)).projectLicense).toBe('MIT');
  });
});

describe('formatLicenses', () => {
  it('says nothing was checked when nothing is installed', async () => {
    const root = await project({ name: 'app', license: 'MIT' }, {});
    const text = formatLicenses(await checkLicenses(root));
    // An empty result from an uninstalled tree looks exactly like a clean bill
    // of health — the substitution this product keeps refusing to make.
    expect(text).toContain('nothing was checked');
    expect(text).not.toContain('✓');
  });

  it('says flagged licenses are not refused', async () => {
    const root = await project(
      { name: 'app', license: 'MIT' },
      { risky: { name: 'risky', license: 'GPL-3.0' } },
    );
    const text = formatLicenses(await checkLicenses(root));
    expect(text).toContain('flagged, not refused');
    expect(text).toContain('risky');
  });

  it('confirms a clean run plainly', async () => {
    const root = await project(
      { name: 'app', license: 'MIT' },
      { dep: { name: 'dep', license: 'MIT' } },
    );
    expect(formatLicenses(await checkLicenses(root))).toContain('compatible');
  });
});

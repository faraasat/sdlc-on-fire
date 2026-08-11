import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageIntelPort } from '@sdlc-on-fire/core';
import { checkDependencies, declaredDependencies, formatDepsCheck } from './deps.js';

/**
 * `sdlc deps check` (P2-SEC-01).
 *
 * The command exists because a check nobody can run is not a check — the v0.1
 * DoD walkthrough found exactly that shape once, where the compiler and doctor
 * shipped as tested library code with nothing wired to a command.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function project(pkg: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg), 'utf8');
  return root;
}

/** Answers from a fixed table, so the gate's behaviour is what is under test. */
const intelReturning = (
  table: Record<string, { advisories?: string[]; downloads?: number; age?: number }>,
): PackageIntelPort => ({
  id: 'test-intel',
  lookup: (packages) =>
    Promise.resolve(
      packages.map((pkg) => {
        const entry = table[pkg.name] ?? {};
        return {
          name: pkg.name,
          ecosystem: pkg.ecosystem,
          advisories: entry.advisories ?? [],
          ...(entry.age === undefined ? {} : { ageDays: entry.age }),
          ...(entry.downloads === undefined ? {} : { monthlyDownloads: entry.downloads }),
          ...(entry.age === undefined && entry.downloads === undefined
            ? {}
            : { repositoryVerified: true }),
        };
      }),
    ),
});

describe('declaredDependencies', () => {
  it('reads every dependency group, deduplicated', async () => {
    const root = await project({
      dependencies: { lodash: '^4.0.0' },
      devDependencies: { vitest: '^1.0.0', lodash: '^4.0.0' },
      optionalDependencies: { fsevents: '^2.0.0' },
    });
    const found = await declaredDependencies(root);
    expect(found.map((d) => d.name).sort()).toEqual(['fsevents', 'lodash', 'vitest']);
  });

  it('skips workspace protocol ranges', async () => {
    const root = await project({ dependencies: { '@sdlc-on-fire/core': 'workspace:*' } });
    // Our own packages are not registry packages; querying them would produce an
    // `assumed` verdict for code we wrote ourselves.
    expect(await declaredDependencies(root)).toEqual([]);
  });

  it('returns nothing rather than throwing on a malformed package.json', async () => {
    const root = await project({});
    await fs.writeFile(path.join(root, 'package.json'), '{{{ not json', 'utf8');
    expect(await declaredDependencies(root)).toEqual([]);
  });

  it('returns nothing when there is no package.json at all', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bare-'));
    dirs.push(root);
    expect(await declaredDependencies(root)).toEqual([]);
  });
});

describe('checkDependencies', () => {
  it('blocks when a dependency carries an advisory', async () => {
    const root = await project({ dependencies: { bad: '^1.0.0', lodash: '^4.0.0' } });
    const result = await checkDependencies(root, {
      intel: intelReturning({
        bad: { advisories: ['GHSA-aaa'], age: 400, downloads: 900 },
        lodash: { age: 3000, downloads: 5_000_000 },
      }),
    });
    expect(result.gate.decision).toBe('blocked');
    expect(result.gate.struck.map((s) => s.name)).toEqual(['bad']);
  });

  it('asks for approval even when everything clears', async () => {
    const root = await project({ dependencies: { lodash: '^4.0.0' } });
    const result = await checkDependencies(root, {
      intel: intelReturning({ lodash: { age: 3000, downloads: 5_000_000 } }),
    });
    expect(result.gate.decision).toBe('needs-human');
  });

  it('honours an explicit opt-out for a clean project', async () => {
    const root = await project({ dependencies: { lodash: '^4.0.0' } });
    const result = await checkDependencies(root, {
      intel: intelReturning({ lodash: { age: 3000, downloads: 5_000_000 } }),
      approveEveryInstall: false,
    });
    expect(result.gate.decision).toBe('allowed');
  });

  it('never lets the opt-out clear a struck package', async () => {
    const root = await project({ dependencies: { bad: '^1.0.0' } });
    const result = await checkDependencies(root, {
      intel: intelReturning({ bad: { advisories: ['GHSA-aaa'], age: 400, downloads: 900 } }),
      approveEveryInstall: false,
    });
    expect(result.gate.decision).toBe('blocked');
  });
});

describe('formatDepsCheck', () => {
  it('says plainly when the lookup reached nothing', async () => {
    const root = await project({ dependencies: { a: '^1.0.0', b: '^1.0.0' } });
    const result = await checkDependencies(root, { intel: intelReturning({}) });

    const text = formatDepsCheck(result);
    // A wall of identical `assumed` verdicts is easy to read as a pass. It
    // means the lookup did not reach anything, and the output has to say so.
    expect(text).toContain('did not');
    expect(text).toContain('not that the packages are clean');
  });

  it('names the cause of a degraded run when the adapter reported one', async () => {
    const root = await project({ dependencies: { a: '^1.0.0' } });
    const result = await checkDependencies(root, { intel: intelReturning({}) });

    // "Offline" and "this checker is broken" produce identical verdicts and
    // need opposite responses. The first build of the OSV adapter was the
    // second case wearing the first case's clothes for its whole life.
    expect(formatDepsCheck({ ...result, degraded: 'osv.dev answered HTTP 400' })).toContain(
      'Cause: osv.dev answered HTTP 400',
    );
  });

  it('does not claim the lookup failed for a project with no dependencies', async () => {
    const root = await project({ dependencies: {} });
    const result = await checkDependencies(root, { intel: intelReturning({}) });
    // Vacuously "every package is assumed" over an empty list would print a
    // connectivity warning at a project that simply has nothing to check.
    expect(formatDepsCheck(result)).not.toContain('not that the packages are clean');
  });

  it('does not cry offline when the lookup worked', async () => {
    const root = await project({ dependencies: { lodash: '^4.0.0' } });
    const result = await checkDependencies(root, {
      intel: intelReturning({ lodash: { age: 3000, downloads: 5_000_000 } }),
    });
    expect(formatDepsCheck(result)).not.toContain('not that the packages are clean');
  });
});

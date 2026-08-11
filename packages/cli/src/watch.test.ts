import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageIntelPort } from '@sdlc-on-fire/core';
import { formatWatch, readWatchRecord, watchDependencies, WATCH_RECORD_PATH } from './watch.js';

/** `sdlc deps watch` (P2-SEC-09). */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function project(installed: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-'));
  dirs.push(root);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');
  for (const [name, license] of Object.entries(installed)) {
    const dir = path.join(root, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, license }), 'utf8');
  }
  return root;
}

/** Answers from a table, so the delta logic is what is under test. */
const intelReturning = (
  table: Record<string, string[]>,
  options: { degrade?: boolean } = {},
): PackageIntelPort => ({
  id: options.degrade === true ? 'osv.dev' : 'test-intel',
  lookup: (packages) =>
    Promise.resolve(
      packages.map((pkg) => ({
        name: pkg.name,
        ecosystem: pkg.ecosystem,
        advisories: table[pkg.name] ?? [],
      })),
    ),
});

describe('watchDependencies', () => {
  it('records a baseline on the first run', async () => {
    const root = await project({ axios: 'MIT' });
    const result = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-a'] }),
    });

    expect(result.delta.baseline).toBe(true);
    expect(result.delta.findings).toEqual([]);

    const stored = await readWatchRecord(root);
    expect(stored?.packages.map((p) => p.name)).toEqual(['axios']);
  });

  it('flags an advisory that appeared since the baseline', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, { intel: () => intelReturning({}) });

    const result = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-new'] }),
    });
    expect(result.delta.findings).toHaveLength(1);
    expect(result.delta.findings[0]?.newAdvisories).toEqual(['GHSA-new']);
  });

  it('does not flag the same advisory twice', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, { intel: () => intelReturning({ axios: ['GHSA-a'] }) });
    await watchDependencies(root, { intel: () => intelReturning({ axios: ['GHSA-a'] }) });

    const third = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-a'] }),
    });
    expect(third.delta.findings).toEqual([]);
  });

  it('leaves the record alone on --dry-run', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, { intel: () => intelReturning({}) });

    await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-new'] }),
      dryRun: true,
    });
    // The finding must still be there next run, or a dry run silently
    // acknowledges an advisory nobody saw.
    const again = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-new'] }),
      dryRun: true,
    });
    expect(again.delta.findings).toHaveLength(1);
  });

  it('does not overwrite a good record with a degraded poll', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, { intel: () => intelReturning({ axios: ['GHSA-a'] }) });

    // An unreachable source returns empty advisories, which look exactly like a
    // clean answer. Overwriting the record with them erases what we knew — and
    // the *next* poll then reports every one of those advisories as newly
    // discovered, an outage manufacturing a false alarm, which is the fastest
    // way to make people ignore the real ones.
    await watchDependencies(root, {
      intel: (onDegraded) => {
        onDegraded('osv.dev answered HTTP 429');
        return intelReturning({});
      },
    });

    const stored = await readWatchRecord(root);
    expect(stored?.packages[0]?.advisories).toEqual(['GHSA-a']);

    // …and the next good poll therefore reports nothing new.
    const after = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-a'] }),
    });
    expect(after.delta.findings).toEqual([]);
  });

  it('sends the installed version to the advisory source', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-v-'));
    dirs.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app' }), 'utf8');
    const dir = path.join(root, 'node_modules', 'lodash');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'lodash', version: '4.17.15' }),
      'utf8',
    );

    let asked: readonly { name: string; version?: string | undefined }[] = [];
    await watchDependencies(root, {
      intel: () => ({
        id: 'test-intel',
        lookup: (packages) => {
          asked = packages;
          return Promise.resolve(
            packages.map((p) => ({ name: p.name, ecosystem: p.ecosystem, advisories: [] })),
          );
        },
      }),
    });

    // Without the version, OSV answers with every advisory the package has ever
    // carried — including ones fixed years ago. That inflates the baseline,
    // buries the one that matters, and means an upgrade that *resolves* an
    // advisory never shows up as resolved. Measured against the live API:
    // lodash unversioned returns 10, 4.17.15 returns 6, 4.17.21 returns 3.
    expect(asked[0]?.version).toBe('4.17.15');
  });

  it('writes the record where local state belongs', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, { intel: () => intelReturning({}) });
    await expect(fs.stat(path.join(root, WATCH_RECORD_PATH))).resolves.toBeDefined();
  });

  it('treats a corrupt record as no record rather than an empty one', async () => {
    const root = await project({ axios: 'MIT' });
    const file = path.join(root, WATCH_RECORD_PATH);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{{{ not json', 'utf8');

    const result = await watchDependencies(root, {
      intel: () => intelReturning({ axios: ['GHSA-a'] }),
    });
    // Reading a corrupt record as an empty baseline would report the whole
    // tree as newly compromised.
    expect(result.delta.baseline).toBe(true);
    expect(result.delta.findings).toEqual([]);
  });

  it('stamps the record with an injected time', async () => {
    const root = await project({ axios: 'MIT' });
    await watchDependencies(root, {
      intel: () => intelReturning({}),
      now: new Date('2026-08-11T12:00:00.000Z'),
    });
    expect((await readWatchRecord(root))?.polledAt).toBe('2026-08-11T12:00:00.000Z');
  });
});

describe('formatWatch', () => {
  it('says a degraded poll is no result rather than a clean one', async () => {
    const root = await project({ axios: 'MIT' });
    const text = formatWatch({
      root,
      source: 'osv.dev',
      packagesPolled: 1,
      delta: { findings: [], unchanged: 1, baseline: false },
      degraded: 'osv.dev answered HTTP 429',
    });
    expect(text).toContain('not a');
    expect(text).toContain('HTTP 429');
    expect(text).toContain('left untouched');
  });
});

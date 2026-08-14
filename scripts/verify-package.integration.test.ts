import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyTarball } from './verify-package.mjs';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * The pre-publish guard (P2-META-01).
 *
 * Every case here builds a real tarball with a real defect and asserts the
 * guard catches it. A checker that only ever says yes is worse than no checker,
 * because it is also reassuring — and this one guards the single action in the
 * repo that cannot be undone.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

interface Layout {
  readonly manifest: Record<string, unknown>;
  readonly files?: Record<string, string> | undefined;
}

/** Packs a synthetic package into a tarball shaped exactly like `npm pack`. */
async function tarball(layout: Layout): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-'));
  dirs.push(root);
  const pkg = path.join(root, 'package');
  await fs.mkdir(pkg, { recursive: true });

  await fs.writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify(layout.manifest, null, 2),
    'utf8',
  );
  for (const [relative, content] of Object.entries(layout.files ?? {})) {
    const full = path.join(pkg, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }

  const out = path.join(root, 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', root, 'package']);
  return out;
}

const healthy: Layout = {
  manifest: {
    name: 'sdlc-on-fire',
    version: '0.2.0',
    description: 'a thing',
    license: 'MIT',
    repository: 'github:faraasat/sdlc-on-fire',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    bin: { sdlc: './dist/index.js' },
    dependencies: { '@sdlc-on-fire/core': '0.2.0', commander: '15.0.0' },
  },
  files: {
    'dist/index.js': '#!/usr/bin/env node\nconsole.log("hi");\n',
    'dist/index.d.ts': 'export {};\n',
  },
};

const withManifest = (over: Record<string, unknown>): Layout => ({
  ...healthy,
  manifest: { ...healthy.manifest, ...over },
});

describe('verifyTarball — a healthy package', () => {
  it('reports nothing wrong', async () => {
    const result = verifyTarball(await tarball(healthy), { expectedVersion: '0.2.0' });
    expect(result.findings).toEqual([]);
    expect(result.name).toBe('sdlc-on-fire');
  });
});

describe('verifyTarball — the defect it was written for', () => {
  it('catches an unreplaced workspace: range', async () => {
    // The real one: release.yml published only packages/cli, whose eight
    // sibling deps were `workspace:*`. `npm install sdlc-on-fire` fails on the
    // first resolve, and no test in this repo would have noticed — every one
    // of them imports from the workspace, where those packages are right there.
    const file = await tarball(
      withManifest({ dependencies: { '@sdlc-on-fire/core': 'workspace:*' } }),
    );
    const result = verifyTarball(file, { expectedVersion: '0.2.0' });
    expect(result.findings.join(' ')).toContain('workspace:*');
    expect(result.findings.join(' ')).toContain('cannot resolve');
  });

  it('catches a sibling pinned to a version this release does not publish', async () => {
    // The same failure wearing a real version number: lockstep `fixed`
    // versioning means siblings move together, so a dep on 0.1.0 during a 0.2.0
    // release resolves to something that was never published.
    const file = await tarball(withManifest({ dependencies: { '@sdlc-on-fire/core': '0.1.0' } }));
    const result = verifyTarball(file, { expectedVersion: '0.2.0' });
    expect(result.findings.join(' ')).toContain('this release publishes 0.2.0');
  });

  it('catches a package whose own version broke lockstep', async () => {
    const result = verifyTarball(await tarball(withManifest({ version: '0.3.0' })), {
      expectedVersion: '0.2.0',
    });
    expect(result.findings.join(' ')).toContain('does not match the lockstep version');
  });
});

describe('verifyTarball — the artifact has to work', () => {
  it('catches a tarball with no dist', async () => {
    const result = verifyTarball(
      await tarball({ manifest: healthy.manifest, files: { 'README.md': '# hi\n' } }),
      { expectedVersion: '0.2.0' },
    );
    expect(result.findings.join(' ')).toContain('no dist/');
  });

  it('catches an entry point that was not packed', async () => {
    const file = await tarball({
      manifest: { ...healthy.manifest, main: './dist/missing.js' },
      files: healthy.files,
    });
    expect(verifyTarball(file, {}).findings.join(' ')).toContain('not in the tarball');
  });

  it('catches a duplicate shebang', async () => {
    // This happened. `dist/index.js` became a syntax error while 320 unit tests
    // stayed green, because every one imported the module instead of running
    // the artifact.
    const file = await tarball({
      manifest: healthy.manifest,
      files: {
        ...healthy.files,
        'dist/index.js': '#!/usr/bin/env node\n#!/usr/bin/env node\nconsole.log(1);\n',
      },
    });
    const result = verifyTarball(file, {});
    expect(result.findings.join(' ')).toContain('2 shebangs');
  });

  it('catches a bin with no shebang at all', async () => {
    const file = await tarball({
      manifest: healthy.manifest,
      files: { ...healthy.files, 'dist/index.js': 'console.log(1);\n' },
    });
    expect(verifyTarball(file, {}).findings.join(' ')).toContain('no shebang');
  });
});

describe('verifyTarball — package-page metadata', () => {
  for (const field of ['license', 'repository', 'description']) {
    it(`catches a missing ${field}`, async () => {
      const manifest = { ...healthy.manifest };
      delete manifest[field];
      const file = await tarball({ manifest, files: healthy.files });
      expect(verifyTarball(file, {}).findings.join(' ')).toContain(`no ${field}`);
    });
  }
});

describe('verifyTarball — reports everything, not just the first thing', () => {
  it('collects findings across categories', async () => {
    const file = await tarball({
      manifest: {
        name: 'broken',
        version: '9.9.9',
        main: './dist/nope.js',
        dependencies: { '@sdlc-on-fire/core': 'workspace:*' },
      },
      files: { 'README.md': '# nothing\n' },
    });
    const result = verifyTarball(file, { expectedVersion: '0.2.0' });
    // One fix beats a sequence of re-runs.
    expect(result.findings.length).toBeGreaterThanOrEqual(5);
  });
});

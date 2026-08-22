import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { runMap } from './map.js';
import { checkSpecs } from './spec.js';

/**
 * `sdlc map` against a real repository (P4-BROWN-02).
 *
 * The mapper is pure and tested in core. What only this can show is the
 * property the whole feature rests on: **an inferred stub does not pass as a
 * specification.** A generated tree that validated cleanly would look like the
 * work was done, and every gate downstream would check against a description
 * nobody agreed to.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

const src = async (relative: string, body = 'export const x = 1;\n'): Promise<void> => {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-map-'));
  await init(root, { database: 'skip' });
  await src('src/billing/invoice.ts');
  await src('src/billing/ledger.ts');
  await src('src/billing/invoice.test.ts');
  await src('src/auth/token.ts');
  await src('src/auth/session.ts');
  await src('src/util/once.ts');
  await src('node_modules/pkg/a.ts');
  await src('node_modules/pkg/b.ts');
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc map', () => {
  it('proposes domains from a real directory tree', async () => {
    const result = await runMap(root);
    expect(result.map.domains.map((d) => d.slug).sort()).toEqual(['auth', 'billing']);
  });

  it('ranks the domain with tests first', async () => {
    expect((await runMap(root)).map.domains[0]?.slug).toBe('billing');
  });

  it('does not propose a single-file directory', async () => {
    expect((await runMap(root)).map.domains.map((d) => d.slug)).not.toContain('util');
  });

  it('never walks into node_modules', async () => {
    const result = await runMap(root);
    expect(result.map.domains.map((d) => d.slug)).not.toContain('pkg');
    // Asserted on `filesScanned`, not on the domain list. The mapper filters
    // ignored paths itself, so a version that walked the whole tree and threw
    // the results away produces an identical domain list — and walking
    // `node_modules` is most of the cost of the walk on any real repository.
    // The count is the only observation that separates the two.
    const baseline = result.map.filesScanned;
    // 60 more files under node_modules. If the walk prunes, the count does not
    // move; if it descends and filters afterwards, it moves by 60.
    for (let i = 0; i < 60; i += 1) await src(`node_modules/pkg/f${String(i)}.ts`);
    expect((await runMap(root)).map.filesScanned).toBe(baseline);
  });

  it('writes nothing unless asked', async () => {
    await runMap(root);
    await expect(fs.access(path.join(root, 'docs', 'specs'))).rejects.toThrow();
  });

  it('writes stubs when asked', async () => {
    const result = await runMap(root, { write: true });
    expect(result.written).toHaveLength(2);
    const stub = await fs.readFile(path.join(root, 'docs', 'specs', 'billing', 'spec.md'), 'utf8');
    expect(stub).toContain('inferred: true');
  });

  it('refuses an inferred stub as a specification', async () => {
    // The property the whole feature rests on. A generated tree that validated
    // cleanly would look like the work was done.
    await runMap(root, { write: true });
    const check = await checkSpecs(root);
    expect(check.ok).toBe(false);
    expect(check.problems.every((p) => p.because.includes('not yet confirmed'))).toBe(true);
  });

  it('accepts the spec once a human writes it and removes the marker', async () => {
    // The act that turns a guess into a specification.
    await runMap(root, { write: true });
    await fs.writeFile(
      path.join(root, 'docs', 'specs', 'billing', 'spec.md'),
      [
        '# billing',
        '',
        '### Requirement: Invoices are immutable once issued',
        '',
        'An issued invoice MUST NOT be edited.',
        '',
        '- GIVEN an issued invoice',
        '- WHEN an edit is attempted',
        '- THEN it is refused',
        '',
      ].join('\n'),
    );
    await fs.rm(path.join(root, 'docs', 'specs', 'auth'), { recursive: true, force: true });
    expect((await checkSpecs(root)).ok).toBe(true);
  });

  it('reports one problem per inferred file, not one per unwritten requirement', async () => {
    // Telling somebody their placeholder lacks an RFC-2119 keyword is true,
    // useless, and buries the message that matters.
    await runMap(root, { write: true });
    const check = await checkSpecs(root);
    expect(check.problems).toHaveLength(2);
  });

  it('never clobbers a spec somebody has started', async () => {
    // The mapper would destroy the exact work it exists to encourage, silently:
    // the file is still there and the words are gone.
    await runMap(root, { write: true });
    const target = path.join(root, 'docs', 'specs', 'billing', 'spec.md');
    await fs.writeFile(target, '# billing\n\nwritten by a person\n');
    const second = await runMap(root, { write: true });
    expect(second.skippedExisting).toContain('specs/billing/spec.md');
    expect(await fs.readFile(target, 'utf8')).toContain('written by a person');
  });

  it('runs on the built binary and emits JSON', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'map', '--json'], { cwd: root });
    const parsed = JSON.parse(stdout) as { map: { domains: { slug: string }[] } };
    expect(parsed.map.domains.map((d) => d.slug).sort()).toEqual(['auth', 'billing']);
  }, 60_000);

  it('says what to do when it finds nothing', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-empty-'));
    await init(empty, { database: 'skip' });
    const { stdout } = await run(process.execPath, [CLI, 'map'], { cwd: empty });
    expect(stdout).toContain('sdlc spec new');
    await fs.rm(empty, { recursive: true, force: true, ...RM_RETRY });
  }, 60_000);
});

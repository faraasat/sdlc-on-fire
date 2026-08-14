import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ordinaryRepo } from './__fixtures__/ordinary-repo.js';

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
 * The product, against a repository that is not this one (P2-QA-07, ADR-0064).
 *
 * ADR-0064's stopgap while no real pilot exists: run against a synthetic but
 * realistic ordinary project — a plain `node --test` suite, a merge in its
 * history, an uncovered corner, a doc linking to a file nobody wrote — rather
 * than only against our own docs-heavy agent-built monorepo.
 *
 * These run the **built binary**, not the library. Every defect this codebase
 * has found in the last several tasks lived in the seam between "the library
 * works" and "a person can reach it", and a pilot that imports functions would
 * be testing the half that was never in doubt.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const roots: string[] = [];

/** Runs the binary in a directory, returning output and exit code rather than throwing. */
async function sdlc(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { cwd, timeout: 120_000 });
    return { out: `${stdout}${stderr}`, code: 0 };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    return { out: `${error.stdout ?? ''}${error.stderr ?? ''}`, code: error.code ?? 1 };
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('an ordinary repository', () => {
  it('takes `init` with no manual surgery', async () => {
    // ADR-0064 criterion 1, and the one most likely to fail on a repo that has
    // never heard of us: `init` has to land in a tree with its own layout,
    // its own package manager and no `.sdlc/` anywhere.
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['init']);
    expect(result.code).toBe(0);

    // And it left the project's own files alone.
    const manifest = JSON.parse(
      await fs.readFile(path.join(repo.root, 'package.json'), 'utf8'),
    ) as { name: string; scripts: Record<string, string> };
    expect(manifest.name).toBe('ordinary-app');
    expect(manifest.scripts['test']).toBe('node --test test/');
  }, 180_000);

  it('never overwrites something the project already had', async () => {
    const repo = await ordinaryRepo();
    roots.push(repo.root);
    const before = await fs.readFile(path.join(repo.root, 'README.md'), 'utf8');

    await sdlc(repo.root, ['init']);
    expect(await fs.readFile(path.join(repo.root, 'README.md'), 'utf8')).toBe(before);
  }, 180_000);

  it('reads a stack that is nothing like ours', async () => {
    // Express and pg, no TypeScript, no workspaces. The detector was written
    // against a pnpm monorepo and this is the shape it was not written against.
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['research', 'scan', '--json']);
    const parsed = JSON.parse(result.out) as { detected: { tech: string }[] };
    expect(parsed.detected.map((tech) => tech.tech).sort()).toEqual(['express', 'pg']);
  }, 180_000);

  it('derives a specialist team for that stack', async () => {
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['roles', '--json']);
    const parsed = JSON.parse(result.out) as { roles: { key: string }[] };
    // `pg` summons the sql specialist; nothing here summons react.
    expect(parsed.roles.map((role) => role.key)).toContain('sql');
    expect(parsed.roles.map((role) => role.key)).not.toContain('react');
  }, 180_000);

  it('finds the tiers an ordinary suite actually has', async () => {
    // A `test/` directory of plain `.test.js` files — not our
    // `.integration.test.ts` convention. A tier report that only recognises our
    // own naming would call this repository untested.
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['tiers', '--json']);
    const parsed = JSON.parse(result.out) as { inventory: { tier: string; files: string[] }[] };
    const unit = parsed.inventory.find((entry) => entry.tier === 'unit');
    expect(unit?.files.length ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('scans a tree it did not write without falling over', async () => {
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['scan', '--json']);
    const parsed = JSON.parse(result.out) as { filesScanned: number };
    expect(parsed.filesScanned).toBeGreaterThan(0);
  }, 180_000);

  it('survives a history with a merge in it', async () => {
    // Anything walking the log meets a shape a linear agent-built history never
    // produces.
    const repo = await ordinaryRepo();
    roots.push(repo.root);
    await sdlc(repo.root, ['init']);

    const result = await sdlc(repo.root, ['status']);
    expect(result.code).toBe(0);
  }, 180_000);

  it('reports the pilot gate as blocked on a repo with no report', async () => {
    // The honest state, on a real tree rather than a fixture directory.
    const repo = await ordinaryRepo();
    roots.push(repo.root);

    const result = await sdlc(repo.root, ['pilot', 'check']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('stays blocked');
  }, 180_000);
});

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkGuard, formatGuardCheck, revertedEntities, type GitRunner } from './guard.js';

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
 * `sdlc guard` (P2-GIT-01).
 *
 * Real repositories with real `git revert` commits. The whole feature reads git
 * history, and a hand-written fixture would only prove the parser agrees with
 * my memory of what `git show` emits.
 */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

async function repo(): Promise<{ root: string; git: GitRunner }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-'));
  dirs.push(root);
  const git: GitRunner = async (args) => {
    const { stdout } = await run('git', args, { cwd: root });
    return stdout;
  };
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.test']);
  await git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'initial']);
  return { root, git };
}

async function commit(
  root: string,
  git: GitRunner,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), content, 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', message]);
  return (await git(['rev-parse', 'HEAD'])).trim();
}

describe('revertedEntities', () => {
  it('reads what a real git revert removed', async () => {
    const { root, git } = await repo();
    const sha = await commit(
      root,
      git,
      'src/pay.ts',
      'export function computeDiscount() {}\n',
      'feat: discount engine',
    );
    await git(['revert', '--no-edit', sha]);

    const found = await revertedEntities(git);
    expect(found.map((e) => e.name)).toContain('computeDiscount');
    expect(found[0]?.subject).toContain('Revert');
  });

  it('finds nothing in a repo with no reverts', async () => {
    const { root, git } = await repo();
    await commit(root, git, 'src/a.ts', 'export function alpha() {}\n', 'feat: alpha');
    expect(await revertedEntities(git)).toEqual([]);
  });

  it('reads a conventional-commits `revert:` subject too', async () => {
    const { root, git } = await repo();
    await commit(root, git, 'src/pay.ts', 'export function computeDiscount() {}\n', 'feat: pay');
    await commit(root, git, 'src/pay.ts', '', 'revert: pay — broke checkout');

    const found = await revertedEntities(git);
    expect(found.map((e) => e.name)).toContain('computeDiscount');
  });
});

describe('checkGuard', () => {
  it('flags a reintroduction in a different file', async () => {
    const { root, git } = await repo();
    const sha = await commit(
      root,
      git,
      'src/pay.ts',
      'export function computeDiscount() {}\n',
      'feat: discount engine',
    );
    await git(['revert', '--no-edit', sha]);

    // Back, under a new path — which is exactly what a path-based check misses.
    await fs.mkdir(path.join(root, 'src/billing'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src/billing/discount.ts'),
      'export function computeDiscount() {}\n',
      'utf8',
    );
    await git(['add', '-A']);

    const result = await checkGuard(root, { git, message: 'feat: discounts again' });
    expect(result.guard.clean).toBe(false);
    expect(result.guard.unacknowledged[0]?.entity).toBe('computeDiscount');
    expect(result.revertsScanned).toBe(1);
  });

  it('passes once the commit message acknowledges it', async () => {
    const { root, git } = await repo();
    const sha = await commit(
      root,
      git,
      'src/pay.ts',
      'export function computeDiscount() {}\n',
      'feat: discount engine',
    );
    await git(['revert', '--no-edit', sha]);
    // `git revert` deleted the file and git prunes the now-empty directory.
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src/pay.ts'),
      'export function computeDiscount() {}\n',
      'utf8',
    );
    await git(['add', '-A']);

    const result = await checkGuard(root, {
      git,
      message: 'feat: reinstate\n\nReintroduces: computeDiscount — rounding bug fixed in #412',
    });
    expect(result.guard.clean).toBe(true);
    expect(result.guard.findings[0]?.acknowledged).toBe(true);
  });

  it('passes an unrelated change', async () => {
    const { root, git } = await repo();
    const sha = await commit(
      root,
      git,
      'src/pay.ts',
      'export function computeDiscount() {}\n',
      'feat: pay',
    );
    await git(['revert', '--no-edit', sha]);

    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'src/ship.ts'),
      'export function computeShipping() {}\n',
      'utf8',
    );
    await git(['add', '-A']);

    expect((await checkGuard(root, { git, message: 'feat: shipping' })).guard.clean).toBe(true);
  });

  it('catches a reverted SQL migration coming back under a new number', async () => {
    const { root, git } = await repo();
    const sha = await commit(
      root,
      git,
      'db/001_sessions.sql',
      'CREATE TABLE user_sessions (id int);\n',
      'feat: sessions table',
    );
    await git(['revert', '--no-edit', sha]);

    await fs.mkdir(path.join(root, 'db'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'db/007_sessions.sql'),
      'CREATE TABLE user_sessions (id int);\n',
      'utf8',
    );
    await git(['add', '-A']);

    const result = await checkGuard(root, { git, message: 'feat: sessions' });
    // The canonical case from the research: a fresh migration number looks
    // like new work to anything matching on paths.
    expect(result.guard.unacknowledged.map((f) => f.entity)).toContain('user_sessions');
  });

  it('survives a bad base ref rather than throwing', async () => {
    const { root, git } = await repo();
    const result = await checkGuard(root, { git, base: 'no-such-ref', message: '' });
    expect(result.guard.clean).toBe(true);
  });
});

describe('formatGuardCheck', () => {
  it('reports how much history it actually looked at', async () => {
    const { root, git } = await repo();
    const text = formatGuardCheck(await checkGuard(root, { git, message: '' }));
    // "Nothing found" means little without knowing what was searched.
    expect(text).toContain('revert(s) in history');
  });
});

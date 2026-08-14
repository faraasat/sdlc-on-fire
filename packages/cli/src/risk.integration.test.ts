import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFiles, checkRisk, formatRisk } from './risk.js';

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
 * `sdlc risk` (P2-SEC-03).
 *
 * The diff-reading half runs against **real git repositories** rather than
 * canned diff text. `git diff --unified=0` output is a format we do not
 * control, and a fixture I wrote by hand would only prove the parser agrees
 * with my memory of it — the same mistake that let a malformed OSV request ship
 * green in P2-SEC-01.
 */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

async function repo(initial: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'risk-'));
  dirs.push(root);
  const git = (args: string[]) => run('git', args, { cwd: root });

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.test']);
  await git(['config', 'user.name', 'Test']);
  await write(root, { 'README.md': '# Test\n', ...initial });
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'initial']);
  return root;
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

const gitIn =
  (root: string) =>
  async (args: readonly string[]): Promise<string> => {
    const { stdout } = await run('git', [...args], { cwd: root });
    return stdout;
  };

describe('changedFiles', () => {
  it('reads paths and added lines from a real diff', async () => {
    const root = await repo();
    await write(root, { 'src/auth/session.ts': 'export const verify = () => true;\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const files = await changedFiles('HEAD', gitIn(root));
    expect(files.map((f) => f.path)).toEqual(['src/auth/session.ts']);
    expect(files[0]?.addedContent).toContain('export const verify');
  });

  it('does not mistake the +++ header for an added line', async () => {
    const root = await repo();
    await write(root, { 'src/a.ts': 'const x = 1;\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const files = await changedFiles('HEAD', gitIn(root));
    expect(files[0]?.addedContent).not.toContain('b/src/a.ts');
  });

  it('separates added lines per file', async () => {
    const root = await repo();
    await write(root, {
      'src/auth/a.ts': 'jwt.verify(t);\n',
      'src/ui/b.ts': 'const label = "hi";\n',
    });
    await run('git', ['add', '-A'], { cwd: root });

    const files = await changedFiles('HEAD', gitIn(root));
    const ui = files.find((f) => f.path === 'src/ui/b.ts');
    // Content bleeding between files would make every change look like an
    // auth change as soon as one file in it was.
    expect(ui?.addedContent).not.toContain('jwt.verify');
  });

  it('returns nothing when the tree is unchanged', async () => {
    const root = await repo();
    expect(await changedFiles('HEAD', gitIn(root))).toEqual([]);
  });

  it('returns nothing rather than throwing on a bad ref', async () => {
    const root = await repo();
    expect(await changedFiles('no-such-ref', gitIn(root))).toEqual([]);
  });
});

describe('checkRisk', () => {
  it('requires a review for a real auth change', async () => {
    const root = await repo();
    await write(root, { 'src/auth/session.ts': 'export const verify = () => true;\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const result = await checkRisk(root, { git: gitIn(root) });
    expect(result.requirement.required).toBe(true);
    expect(result.requirement.surfaces).toEqual(['auth']);
    expect(result.cards).toHaveLength(1);
  });

  it('requires nothing for an ordinary change', async () => {
    const root = await repo();
    await write(root, { 'src/components/Button.tsx': 'export const Button = () => null;\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const result = await checkRisk(root, { git: gitIn(root) });
    expect(result.requirement.required).toBe(false);
    expect(result.cards).toEqual([]);
  });

  it('catches a surface introduced in a file whose path says nothing', async () => {
    const root = await repo({ 'src/utils/helpers.ts': 'export const noop = () => {};\n' });
    await write(root, {
      'src/utils/helpers.ts':
        'export const noop = () => {};\nexport const ok = jwt.verify(t, s);\n',
    });
    await run('git', ['add', '-A'], { cwd: root });

    const result = await checkRisk(root, { git: gitIn(root) });
    // The case the path rules structurally cannot reach, verified end to end
    // through real `git diff` output.
    expect(result.requirement.surfaces).toEqual(['auth']);
  });

  it('does not fire on an unrelated edit to a file that already had a surface', async () => {
    const root = await repo({ 'src/lib/sync.ts': 'const r = await fetch(url);\n' });
    await write(root, { 'src/lib/sync.ts': 'const r = await fetch(url);\n// a comment\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const result = await checkRisk(root, { git: gitIn(root) });
    // Reading whole files instead of added lines would make this a finding,
    // and every subsequent edit to the file too.
    expect(result.requirement.required).toBe(false);
  });
});

describe('formatRisk', () => {
  it('says plainly that an agent cannot sign it off', async () => {
    const root = await repo();
    await write(root, { 'src/auth/session.ts': 'export const verify = () => true;\n' });
    await run('git', ['add', '-A'], { cwd: root });

    const text = formatRisk(await checkRisk(root, { git: gitIn(root) }));
    expect(text).toContain('REQUIRED');
    expect(text).toContain('an agent approval does not count');
  });

  it('says so when nothing is required', async () => {
    const root = await repo();
    const text = formatRisk(await checkRisk(root, { git: gitIn(root) }));
    expect(text).toContain('no high-risk surface');
  });
});

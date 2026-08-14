import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkResolution,
  declarationsFor,
  formatListing,
  listConflicts,
  originalConflict,
  unmergedPaths,
  type GitRunner,
} from './conflicts.js';

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
 * `sdlc conflicts` (P2-GIT-02).
 *
 * Real repositories with a real `git merge` that really conflicts. The whole
 * feature reads git's unmerged index, and a hand-written fixture would only
 * prove the parser agrees with my memory of what git writes into a conflicted
 * file — which is exactly the assumption worth not making.
 */

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

/** A repo whose `main` and `feature` branches both edited one file. */
async function conflictedRepo(): Promise<{ root: string; git: GitRunner }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'conflicts-')));
  dirs.push(root);
  const git: GitRunner = async (args) => {
    const { stdout } = await run('git', args, { cwd: root });
    return stdout;
  };

  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.test']);
  await git(['config', 'user.name', 'Test']);

  const file = path.join(root, 'config.ts');
  await fs.writeFile(file, 'export const config = {\n  timeout: 10,\n};\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'base']);

  await git(['checkout', '-q', '-b', 'feature']);
  await fs.writeFile(file, 'export const config = {\n  timeout: 60,\n};\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'slow network']);

  await git(['checkout', '-q', 'main']);
  await fs.writeFile(file, 'export const config = {\n  timeout: 30,\n  retries: 3,\n};\n', 'utf8');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'retries']);

  // Expected to exit non-zero: the conflict is the point.
  await git(['merge', 'feature']).catch(() => '');
  return { root, git };
}

describe('unmergedPaths', () => {
  it('reports what git says is unmerged', async () => {
    const { git } = await conflictedRepo();
    expect(await unmergedPaths(git)).toEqual(['config.ts']);
  });

  it('reports nothing on a clean tree', async () => {
    const { git } = await conflictedRepo();
    await git(['merge', '--abort']);
    expect(await unmergedPaths(git)).toEqual([]);
  });

  it('does not report a file that merely contains marker-shaped text', async () => {
    // This repository has such files — a document about merge conflicts, and
    // this very test. Scanning the tree for markers instead of asking git would
    // report conflicts in a clean checkout.
    const { root, git } = await conflictedRepo();
    await git(['merge', '--abort']);
    await fs.writeFile(
      path.join(root, 'notes.md'),
      '# Markers\n\n<<<<<<< HEAD\nnot a conflict\n=======\nstill not\n>>>>>>> other\n',
      'utf8',
    );
    expect(await unmergedPaths(git)).toEqual([]);
  });
});

describe('listConflicts', () => {
  it('parses the hunks git actually wrote into the file', async () => {
    const { root, git } = await conflictedRepo();
    const listing = await listConflicts(root, git);
    expect(listing.files.map((f) => f.path)).toEqual(['config.ts']);
    expect(listing.totalHunks).toBe(1);

    const hunk = listing.files[0]?.hunks[0];
    expect(hunk?.ours.join('\n')).toContain('retries: 3');
    expect(hunk?.theirs.join('\n')).toContain('timeout: 60');
  });

  it('reports whether git recorded a common ancestor', async () => {
    // Default `merge.conflictStyle` is `merge`, which records none. The listing
    // says so rather than presenting a two-sided view as if it were complete.
    const { root, git } = await conflictedRepo();
    expect((await listConflicts(root, git)).hasAncestors).toBe(false);

    await git(['merge', '--abort']);
    await git(['config', 'merge.conflictStyle', 'diff3']);
    await git(['merge', 'feature']).catch(() => '');
    expect((await listConflicts(root, git)).hasAncestors).toBe(true);
  });

  it('proposes nothing', async () => {
    // The listing is the input to reasoning. A command that both writes and
    // blesses a resolution has no disposer left in it.
    const { root, git } = await conflictedRepo();
    const text = formatListing(await listConflicts(root, git));
    expect(text).toContain('Nothing here is a proposed resolution');
    expect(text).toContain('no test has seen this one');
  });

  it('says so plainly when there is nothing to resolve', async () => {
    const { root, git } = await conflictedRepo();
    await git(['merge', '--abort']);
    expect(formatListing(await listConflicts(root, git))).toBe('No unmerged files.');
  });
});

describe('originalConflict', () => {
  it('reconstructs the conflicted content from the index', async () => {
    const { root, git } = await conflictedRepo();
    const scratch = path.join(root, '.scratch');
    const original = await originalConflict(git, 'config.ts', scratch);
    expect(original).toContain('<<<<<<<');
    expect(original).toContain('retries: 3');
    expect(original).toContain('timeout: 60');
  });

  it('does not overwrite the resolved working file', async () => {
    // The obvious recovery, `git checkout --merge -- <path>`, regenerates the
    // conflict by destroying the resolution being reviewed. A review step that
    // eats the work it reviews is worse than no review step.
    const { root, git } = await conflictedRepo();
    const resolved = 'export const config = {\n  timeout: 60,\n  retries: 3,\n};\n';
    await fs.writeFile(path.join(root, 'config.ts'), resolved, 'utf8');

    await originalConflict(git, 'config.ts', path.join(root, '.scratch'));
    expect(await fs.readFile(path.join(root, 'config.ts'), 'utf8')).toBe(resolved);
  });

  it('carries the common ancestor into the reconstruction', async () => {
    // Requested explicitly rather than depending on the repo's own
    // `merge.conflictStyle` — the reconstruction is where the ancestor is most
    // useful, and it costs nothing to ask for it.
    const { root, git } = await conflictedRepo();
    const original = await originalConflict(git, 'config.ts', path.join(root, '.scratch'));
    expect(original).toContain('|||||||');
    expect(original).toContain('timeout: 10');
  });

  it('returns nothing for a path that is not unmerged', async () => {
    const { root, git } = await conflictedRepo();
    await git(['merge', '--abort']);
    expect(await originalConflict(git, 'config.ts', path.join(root, '.scratch'))).toBeNull();
  });

  it('labels the sides with branches, not with the temp files it built', async () => {
    // Without `-L`, `merge-file` labels each side with the path it was handed,
    // so every finding downstream names a scratch file and the review reads as
    // though the conflict were between two temp files. Found by running the
    // built binary; the library tests had no way to see it.
    const { root, git } = await conflictedRepo();
    const original = (await originalConflict(git, 'config.ts', path.join(root, '.scratch'))) ?? '';
    expect(original).toContain('<<<<<<< main');
    expect(original).toContain('>>>>>>> feature');
    expect(original).not.toContain('.scratch');
  });
});

describe('checkResolution, against a real conflict', () => {
  const head = { git_sha: 'a'.repeat(40) };

  async function original(): Promise<{ root: string; git: GitRunner; conflicted: string }> {
    const { root, git } = await conflictedRepo();
    const conflicted =
      (await originalConflict(git, 'config.ts', path.join(root, '.scratch'))) ?? '';
    return { root, git, conflicted };
  }

  it('refuses a silent `--ours`', async () => {
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      'export const config = {\n  timeout: 30,\n  retries: 3,\n};\n',
      [],
      { ...head, passed: true },
      head,
    );
    expect(result.accepted).toBe(false);
    expect(result.review.findings.map((f) => f.message).join(' ')).toContain(
      'indistinguishable from an accident',
    );
  });

  it('accepts a declared `--ours` that was re-tested', async () => {
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      'export const config = {\n  timeout: 30,\n  retries: 3,\n};\n',
      [{ hunk: 0, rationale: 'the slow-network timeout was superseded by the retry policy' }],
      { ...head, passed: true },
      head,
    );
    expect(result.accepted).toBe(true);
  });

  it('refuses a structurally clean resolution nothing has re-tested', async () => {
    // The two checks are independent and a resolution needs both. This is the
    // case `.research/27 §2.5` calls out by name.
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      'export const config = {\n  timeout: 60,\n  retries: 3,\n};\n',
      [],
      null,
      head,
    );
    expect(result.review.structurallyOk).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.verdict.reason).toContain('nothing about it has been tested');
  });

  it('refuses a resolution still carrying markers', async () => {
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      conflicted,
      [],
      { ...head, passed: true },
      head,
    );
    expect(result.accepted).toBe(false);
    expect(result.review.findings[0]?.message).toContain('not a resolution');
  });

  it('accepts a union with no declaration, since nothing was discarded', async () => {
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      'export const config = {\n  timeout: 60,\n  retries: 3,\n};\n',
      [],
      { ...head, passed: true },
      head,
    );
    expect(result.accepted).toBe(true);
  });

  it('refuses a resolution whose re-run failed', async () => {
    const { conflicted } = await original();
    const result = checkResolution(
      'config.ts',
      conflicted,
      'export const config = {\n  timeout: 60,\n  retries: 3,\n};\n',
      [],
      { ...head, passed: false },
      head,
    );
    expect(result.accepted).toBe(false);
    expect(result.verdict.reason).toContain('failed');
  });
});

describe('declarationsFor (P2-SKILL-07)', () => {
  const output = {
    work_item_id: 'FEAT-001',
    resolutions: [
      {
        file: 'config.ts',
        hunk: 0,
        kind: 'ours',
        rationale: 'the slow-network timeout was superseded by the retry policy',
      },
      { file: 'other.ts', hunk: 0, kind: 'union', rationale: 'kept both sides of the other file' },
    ],
  };

  it('reads the declarations for the file being checked', () => {
    const declared = declarationsFor(output, 'config.ts');
    expect(declared).toHaveLength(1);
    expect(declared[0]?.hunk).toBe(0);
  });

  it('does not let another file’s declaration cover this one', () => {
    // Otherwise one rationale written about `other.ts` silently satisfies the
    // drop in `config.ts`, which is the declaration requirement defeating
    // itself.
    expect(declarationsFor(output, 'unrelated.ts')).toEqual([]);
  });

  it('carries the claimed kind through, which is the whole point', () => {
    // Without `kind` the checker has nothing to compare against the file, and
    // the skill's account of itself goes unchecked.
    expect(declarationsFor(output, 'config.ts')[0]?.kind).toBe('ours');
  });

  it('leaves kind absent when the skill did not claim one', () => {
    const declared = declarationsFor(
      { resolutions: [{ file: 'a.ts', hunk: 1, rationale: 'x'.repeat(30) }] },
      'a.ts',
    );
    expect(declared[0]?.kind).toBeUndefined();
  });

  it('skips a malformed entry rather than failing the whole check', () => {
    // A declaration nobody can parse leaves the hunk *undeclared*, which the
    // review already blocks on. Refusing to run because one entry was malformed
    // would turn a missing declaration into a missing check.
    const declared = declarationsFor(
      {
        resolutions: [
          { file: 'a.ts', hunk: 'zero', rationale: 'not a number' },
          { file: 'a.ts', rationale: 'no hunk at all' },
          { file: 'a.ts', hunk: 2 },
          null,
          { file: 'a.ts', hunk: 3, rationale: 'this one is fine and long enough' },
        ],
      },
      'a.ts',
    );
    expect(declared.map((d) => d.hunk)).toEqual([3]);
  });

  it('returns nothing for output that carries no resolutions', () => {
    expect(declarationsFor({}, 'a.ts')).toEqual([]);
    expect(declarationsFor(null, 'a.ts')).toEqual([]);
    expect(declarationsFor('not an object', 'a.ts')).toEqual([]);
    expect(declarationsFor({ resolutions: 'not an array' }, 'a.ts')).toEqual([]);
  });
});

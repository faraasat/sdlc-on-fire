import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  explainConflict,
  formatReview,
  hasConflictMarkers,
  parseConflicts,
  splitLines,
  resolutionVerified,
  reviewResolution,
  type ConflictHunk,
  type DeclaredResolution,
  type ResolutionEvidence,
  type ResolutionReview,
  type VerificationVerdict,
} from '@sdlc-on-fire/core';

/**
 * `sdlc conflicts` — the reasoning-partner surface for merge conflicts
 * (P2-GIT-02, `.research/techniques/27 §2.5`).
 *
 * Two modes, and keeping them apart is the design:
 *
 * - **Listing** lays out both sides of every conflict, with the common
 *   ancestor where git recorded one. This is the *input* to reasoning — human
 *   or model — and it deliberately proposes nothing.
 * - **Checking** reviews what was actually written back, and refuses a
 *   resolution that dropped a side without saying so or that nothing has
 *   re-tested.
 *
 * There is no third mode that resolves the conflict. Not because a model could
 * not produce a plausible resolution — it can, easily, which is the problem —
 * but because a command that both writes and blesses the resolution has no
 * disposer left in it.
 */

const run = promisify(execFile);

export type GitRunner = (args: readonly string[]) => Promise<string>;

export const defaultGit =
  (cwd: string): GitRunner =>
  async (args) => {
    const { stdout } = await run('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };

/**
 * Files git itself reports as unmerged.
 *
 * `git diff --name-only --diff-filter=U` rather than scanning the tree for
 * marker text: a file can contain marker-shaped lines without being in
 * conflict (a test fixture, a document about merge conflicts — this
 * repository has both), and git's index is the only thing that actually knows.
 */
export async function unmergedPaths(git: GitRunner): Promise<string[]> {
  const out = await git(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export interface ConflictedFile {
  readonly path: string;
  readonly hunks: readonly ConflictHunk[];
}

export interface ConflictListing {
  readonly files: readonly ConflictedFile[];
  readonly totalHunks: number;
  /** True when git recorded a common ancestor for every hunk. */
  readonly hasAncestors: boolean;
}

export async function listConflicts(root: string, git: GitRunner): Promise<ConflictListing> {
  const files: ConflictedFile[] = [];
  for (const rel of await unmergedPaths(git)) {
    const raw = await fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
    if (raw === null) continue;
    files.push({ path: rel, hunks: parseConflicts(raw) });
  }

  const all = files.flatMap((file) => file.hunks);
  return {
    files,
    totalHunks: all.length,
    hasAncestors: all.length > 0 && all.every((hunk) => hunk.base !== undefined),
  };
}

export function formatListing(listing: ConflictListing): string {
  if (listing.files.length === 0) return 'No unmerged files.';

  const lines: string[] = [];
  for (const file of listing.files) {
    lines.push(`── ${file.path} — ${String(file.hunks.length)} hunk(s)`, '');
    for (const hunk of file.hunks) lines.push(explainConflict(hunk), '');
  }

  lines.push(
    `${String(listing.totalHunks)} hunk(s) across ${String(listing.files.length)} file(s).`,
    '',
    'Nothing here is a proposed resolution. Resolve the files, then run',
    '`sdlc conflicts --check --why <hunk>=<rationale>` and re-run the checks —',
    'a resolution is a code change, and no test has seen this one.',
  );
  return lines.join('\n');
}

export interface CheckResult {
  readonly path: string;
  readonly review: ResolutionReview;
  readonly verdict: VerificationVerdict;
  readonly accepted: boolean;
}

/**
 * Reviews a resolved file against the conflict it used to contain.
 *
 * The original conflicted content has to come from somewhere, and the caller
 * supplies it: after resolution the working tree no longer holds it, and git's
 * index stage entries are the honest source. Reconstructing it from the
 * resolved file would mean inferring what the sides were from what survived,
 * which is precisely the question being asked.
 */
export function checkResolution(
  filePath: string,
  original: string,
  resolved: string,
  declared: readonly DeclaredResolution[],
  evidence: ResolutionEvidence | null,
  head: { git_sha: string; dirty_tree_hash?: string | undefined },
): CheckResult {
  const hunks = parseConflicts(original);
  // The same splitter the hunks were parsed with. Two different splitters over
  // a CRLF file produce lines that never compare equal, and every hunk would
  // classify as a rewrite.
  const resolvedLines = splitLines(resolved);

  // Each hunk is classified against the whole resolved file. Segmenting it per
  // hunk would need an alignment the resolution may legitimately have destroyed
  // (a hunk moved, merged with its neighbour, or hoisted out of a function).
  // The original content goes in alongside so the file's own surrounding lines
  // are not mistaken for code written at the merge boundary — the defect the
  // first run against a real `git merge` exposed.
  const review = reviewResolution(
    hunks,
    hunks.map(() => resolvedLines),
    declared,
    resolved,
    original,
  );
  const verdict = resolutionVerified(evidence, head);

  return {
    path: filePath,
    review,
    verdict,
    accepted: review.structurallyOk && verdict.verified,
  };
}

/**
 * Reconstructs the conflicted content git produced, without touching the tree.
 *
 * The index keeps all three sides of an unmerged path as stages 1 (common
 * ancestor), 2 (ours) and 3 (theirs), and `git merge-file` will re-derive the
 * marked-up file from them on stdout. That matters: the obvious way to recover
 * the original is `git checkout --merge -- <path>`, which regenerates the
 * conflict **by overwriting the working file** — destroying the very resolution
 * the caller is asking to have reviewed. A review step that can eat the work
 * it is reviewing is worse than no review step.
 *
 * `--diff3` is requested so the ancestor survives into the output; whoever
 * reasons about the hunk then sees what each side *changed* rather than only
 * what each side now says.
 *
 * Returns `null` when the path is not unmerged, which includes the ordinary
 * case of a caller checking a file after the merge was already committed.
 */
export async function originalConflict(
  git: GitRunner,
  rel: string,
  scratchDir: string,
): Promise<string | null> {
  const stages = await git(['ls-files', '-u', '--', rel]).catch(() => '');
  if (stages.trim() === '') return null;

  const write = async (stage: number, name: string): Promise<string> => {
    // Stage 1 is absent for an add/add conflict — two branches created the same
    // path independently, so there is no ancestor. Empty is the correct base
    // there, and it is a real case rather than an error.
    const blob = await git(['show', `:${String(stage)}:${rel}`]).catch(() => '');
    const target = path.join(scratchDir, name);
    await fs.writeFile(target, blob, 'utf8');
    return target;
  };

  await fs.mkdir(scratchDir, { recursive: true });
  const [ours, base, theirs] = await Promise.all([
    write(2, 'ours'),
    write(1, 'base'),
    write(3, 'theirs'),
  ]);

  // `-L` supplies the marker labels. Without it `merge-file` labels each side
  // with the *path it was handed*, so the reconstruction comes back marked
  // `<<<<<<< /tmp/.../ours` and every finding downstream names a temp file
  // instead of a branch — the review reads as though the conflict were between
  // two scratch files. Real branch names where git knows them, the plain words
  // otherwise.
  const oursLabel = (await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const theirsLabel =
    (await git(['name-rev', '--name-only', 'MERGE_HEAD'])
      .catch(() => '')
      .then((out) => out.trim())) || 'theirs';

  // `merge-file` exits non-zero when conflicts remain, which is the expected
  // outcome here — the conflict is the thing being reconstructed.
  return git([
    'merge-file',
    '-p',
    '--diff3',
    '-L',
    oursLabel === '' ? 'ours' : oursLabel,
    '-L',
    'common ancestor',
    '-L',
    theirsLabel,
    ours,
    base,
    theirs,
  ]).catch((error: { stdout?: string }) => error.stdout ?? '');
}

export function formatCheck(result: CheckResult): string {
  return [`── ${result.path}`, formatReview(result.review, result.verdict)].join('\n');
}

/**
 * Declarations read from the `resolve-conflict` skill's own output
 * (P2-SKILL-07).
 *
 * The skill emits `resolutions[]` through its output contract, each carrying
 * the hunk, the rationale, and the `kind` it believes it produced. Reading them
 * here is what turns that `kind` from a sentence in a report into something the
 * checker compares against the file — an agent claiming `union` while the file
 * kept one side is caught rather than believed.
 *
 * Malformed entries are skipped rather than fatal: a declaration nobody can
 * parse leaves the hunk *undeclared*, which the review already blocks on. That
 * is the right failure — refusing to run because one entry was malformed would
 * turn a missing declaration into a missing check.
 */
export function declarationsFor(
  output: unknown,
  file: string,
): readonly (DeclaredResolution & { file: string })[] {
  const resolutions =
    typeof output === 'object' && output !== null
      ? (output as { resolutions?: unknown }).resolutions
      : undefined;
  if (!Array.isArray(resolutions)) return [];

  const declared: (DeclaredResolution & { file: string })[] = [];
  for (const entry of resolutions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (row['file'] !== file) continue;
    if (typeof row['hunk'] !== 'number' || typeof row['rationale'] !== 'string') continue;
    declared.push({
      file,
      hunk: row['hunk'],
      rationale: row['rationale'],
      ...(typeof row['kind'] === 'string'
        ? { kind: row['kind'] as DeclaredResolution['kind'] }
        : {}),
    });
  }
  return declared;
}

export { hasConflictMarkers };

/**
 * Merge-conflict resolution as a reasoning partner (P2-GIT-02, FEAT-GIT-013,
 * `.research/techniques/27 §2.5`).
 *
 * The research settles the shape and it is worth restating precisely, because
 * the tempting design is the wrong one. `techniques/27` surveys the 2026 field
 * — GitKraken's AI-suggested resolution, LLMinus over Linux-kernel history, the
 * search-based vs LLM-based comparison — and lands on: treat the model as
 * something that **explains the semantic difference between the two sides**,
 * and *always* re-run real tests after any agent-assisted resolution rather
 * than trusting the resolution itself as evidence.
 *
 * That is ADR-0040 with a merge conflict in front of it. So the split here is:
 *
 * - **The model proposes.** It reads both sides and explains why each changed
 *   what it changed. That explanation is *recorded and never checked*, which is
 *   stated plainly rather than dressed up — an explanation is exactly the
 *   artifact no deterministic checker can validate, and pretending otherwise
 *   would be the substitution this product refuses.
 * - **The checker disposes.** Three mechanical questions, none of which need a
 *   model: are conflict markers gone, was a side dropped, and does evidence
 *   exist that post-dates the resolution.
 *
 * **The failure mode the checker is built around** is not a resolution that
 * looks wrong. It is `--ours`. Taking one side wholesale resolves the conflict,
 * removes every marker, compiles, and silently discards whatever the other side
 * was for — and the resulting file looks exactly like a careful merge. Nothing
 * downstream can tell the difference, which is why the check has to happen
 * here, at the moment the shape of the resolution is still legible.
 *
 * Dropping a side is therefore **allowed and must be declared**. It is often
 * correct; what is never correct is dropping one by accident and having nothing
 * record that a decision was made.
 */

import { isStale } from './evidence.js';

export const CONFLICT_MARKERS = {
  ours: '<<<<<<<',
  base: '|||||||',
  divider: '=======',
  theirs: '>>>>>>>',
} as const;

export interface ConflictHunk {
  /** Position in the file, 0-based, in the order git wrote them. */
  readonly index: number;
  /** 1-based line of the `<<<<<<<` marker. */
  readonly startLine: number;
  readonly oursLabel: string;
  readonly theirsLabel: string;
  readonly ours: readonly string[];
  /**
   * The common ancestor, present only under `merge.conflictStyle = diff3`.
   *
   * Absent is not empty. A hunk with no recorded base means the repository is
   * not configured to emit one, which is a different fact from "the ancestor
   * was blank" — and the two would lead to opposite readings of what each side
   * actually did.
   */
  readonly base?: readonly string[] | undefined;
  readonly theirs: readonly string[];
}

export function hasConflictMarkers(content: string): boolean {
  return content
    .split('\n')
    .some(
      (line) => line.startsWith(CONFLICT_MARKERS.ours) || line.startsWith(CONFLICT_MARKERS.theirs),
    );
}

/**
 * Every conflict hunk in a file, as git left it.
 *
 * A hand-rolled scan rather than a regex: conflict bodies routinely contain
 * text that looks like markers (a diff inside a test fixture, a Markdown rule
 * of equals signs), and marker recognition has to be anchored to line starts in
 * a strict order — an unanchored pattern finds hunks inside string literals and
 * reports conflicts in files that have none.
 */
export function parseConflicts(content: string): ConflictHunk[] {
  const lines = content.split('\n');
  const hunks: ConflictHunk[] = [];

  let index = 0;
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (!line.startsWith(CONFLICT_MARKERS.ours)) {
      cursor += 1;
      continue;
    }

    const startLine = cursor + 1;
    const oursLabel = line.slice(CONFLICT_MARKERS.ours.length).trim();
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    let sawBase = false;
    let theirsLabel = '';
    let closed = false;

    cursor += 1;
    while (cursor < lines.length) {
      const current = lines[cursor] ?? '';
      if (current.startsWith(CONFLICT_MARKERS.base)) {
        section = 'base';
        sawBase = true;
      } else if (current === CONFLICT_MARKERS.divider) {
        section = 'theirs';
      } else if (current.startsWith(CONFLICT_MARKERS.theirs)) {
        theirsLabel = current.slice(CONFLICT_MARKERS.theirs.length).trim();
        closed = true;
        cursor += 1;
        break;
      } else if (section === 'ours') ours.push(current);
      else if (section === 'base') base.push(current);
      else theirs.push(current);
      cursor += 1;
    }

    // An unterminated hunk is a truncated or hand-mangled file. Reporting it as
    // a well-formed conflict would invite a "resolution" of half a hunk.
    if (!closed) break;

    hunks.push({
      index,
      startLine,
      oursLabel,
      theirsLabel,
      ours,
      ...(sawBase ? { base } : {}),
      theirs,
    });
    index += 1;
  }

  return hunks;
}

/**
 * What a resolution did with a hunk.
 *
 * - `ours` / `theirs` — one side kept, the other gone.
 * - `union` — everything from both sides.
 * - `synthesis` — lines from both plus lines from neither: someone wrote code.
 * - `neither` — nothing from either side survived.
 */
export type ResolutionKind = 'ours' | 'theirs' | 'union' | 'synthesis' | 'neither';

const meaningful = (lines: readonly string[]): string[] =>
  lines.map((line) => line.trim()).filter((line) => line !== '');

/**
 * Classifies a resolution by which side's lines survived.
 *
 * Deliberately line-set based rather than AST-based. An AST comparison would be
 * sharper on the languages it has a grammar for and silent on the rest, and a
 * merge conflict lands in `.sql`, `.yml`, `.lock` and prose at least as often
 * as in TypeScript — the same reasoning that settled the revert guard's
 * matching depth (P2-GIT-01). A coarse check that works everywhere beats a
 * precise one that quietly covers a third of the conflicts.
 */
export function classifyResolution(
  hunk: ConflictHunk,
  resolved: readonly string[],
  /**
   * Lines the file already contained outside this hunk.
   *
   * Without it, a caller that passes the whole resolved file gets `synthesis`
   * for every hunk, because the surrounding context — the `const config = {`
   * above the conflict and the `};` below it — belongs to neither side and so
   * reads as code written at the merge boundary. That is not a hypothetical:
   * it is what the first run against a real `git merge` produced, while the
   * unit tests passed because they handed over hunk-sized slices nobody has in
   * practice. Novelty is therefore judged against everything the file held
   * before the resolution, not against the two sides alone.
   */
  context: readonly string[] = [],
): ResolutionKind {
  const ours = new Set(meaningful(hunk.ours));
  const theirs = new Set(meaningful(hunk.theirs));
  const known = new Set(meaningful(context));
  const kept = meaningful(resolved);

  const fromOurs = kept.some((line) => ours.has(line) && !theirs.has(line));
  const fromTheirs = kept.some((line) => theirs.has(line) && !ours.has(line));
  const novel = kept.some((line) => !ours.has(line) && !theirs.has(line) && !known.has(line));
  const shared = kept.some((line) => ours.has(line) && theirs.has(line));

  if (!fromOurs && !fromTheirs && !shared) return novel ? 'synthesis' : 'neither';
  if (fromOurs && fromTheirs) return novel ? 'synthesis' : 'union';
  if (novel) return 'synthesis';
  return fromOurs ? 'ours' : fromTheirs ? 'theirs' : 'union';
}

export interface ResolutionFinding {
  readonly severity: 'blocking' | 'declare';
  readonly hunk: number;
  readonly kind: ResolutionKind;
  readonly message: string;
}

/**
 * A resolver's account of what it did, per hunk.
 *
 * `rationale` is the reasoning partner's actual output — why each side changed
 * what it changed, and why this resolution is right. It is stored and shown to
 * a reviewer and **is not validated**, because there is no deterministic way to
 * validate prose. What *is* validated is that a rationale exists wherever a
 * side was dropped, which is a different and checkable claim.
 */
export interface DeclaredResolution {
  readonly hunk: number;
  readonly rationale: string;
}

const MIN_RATIONALE = 20;

export interface ResolutionReview {
  readonly findings: readonly ResolutionFinding[];
  readonly kinds: readonly ResolutionKind[];
  /** True when nothing blocking remains. Still not "verified" — see {@link resolutionVerified}. */
  readonly structurallyOk: boolean;
}

/**
 * Reviews a resolution against the conflict it resolved.
 *
 * `resolvedHunks[i]` is the text that replaced `hunks[i]`. Callers that cannot
 * segment the resolved file that way should pass the whole file once per hunk;
 * the classification is set-based and tolerates the extra context.
 */
export function reviewResolution(
  hunks: readonly ConflictHunk[],
  resolvedHunks: readonly (readonly string[])[],
  declared: readonly DeclaredResolution[] = [],
  resolvedContent = '',
  /**
   * The conflicted file as git wrote it, when the caller has it.
   *
   * Supplies {@link classifyResolution}'s context: everything outside the hunk
   * markers was already in the file, so it is not new code however it lands in
   * the resolution.
   */
  originalContent = '',
): ResolutionReview {
  const findings: ResolutionFinding[] = [];
  const kinds: ResolutionKind[] = [];
  const byHunk = new Map(declared.map((entry) => [entry.hunk, entry]));

  const context = originalContent
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith(CONFLICT_MARKERS.ours) &&
        !line.startsWith(CONFLICT_MARKERS.theirs) &&
        !line.startsWith(CONFLICT_MARKERS.base) &&
        line !== CONFLICT_MARKERS.divider,
    );

  if (hasConflictMarkers(resolvedContent)) {
    findings.push({
      severity: 'blocking',
      hunk: -1,
      kind: 'neither',
      message:
        'conflict markers are still in the file — this is not a resolution, and a commit containing them will compile in exactly the languages where that is worst',
    });
  }

  hunks.forEach((hunk, position) => {
    const kind = classifyResolution(hunk, resolvedHunks[position] ?? [], context);
    kinds.push(kind);

    const rationale = (byHunk.get(hunk.index)?.rationale ?? '').trim();
    const declaredWell = rationale.length >= MIN_RATIONALE;

    if (kind === 'ours' || kind === 'theirs') {
      const dropped = kind === 'ours' ? hunk.theirsLabel || 'theirs' : hunk.oursLabel || 'ours';
      if (!declaredWell) {
        findings.push({
          severity: 'blocking',
          hunk: hunk.index,
          kind,
          message: `hunk ${String(hunk.index)} took ${kind} and discarded ${dropped} with no rationale — taking a side is often right, but an undeclared drop is indistinguishable from an accident`,
        });
      } else {
        findings.push({
          severity: 'declare',
          hunk: hunk.index,
          kind,
          message: `hunk ${String(hunk.index)} discarded ${dropped}: ${rationale}`,
        });
      }
    }

    if (kind === 'neither') {
      findings.push({
        severity: 'blocking',
        hunk: hunk.index,
        kind,
        message: `hunk ${String(hunk.index)} kept nothing from either side — both changes are gone, and whatever the conflict was about is unresolved rather than resolved`,
      });
    }

    if (kind === 'synthesis' && !declaredWell) {
      findings.push({
        severity: 'blocking',
        hunk: hunk.index,
        kind,
        message: `hunk ${String(hunk.index)} contains code from neither side with no rationale — new code written at a merge boundary is the least-reviewed code in the repository`,
      });
    }
  });

  return {
    findings,
    kinds,
    structurallyOk: !findings.some((finding) => finding.severity === 'blocking'),
  };
}

export interface ResolutionEvidence {
  readonly git_sha: string;
  readonly dirty_tree_hash?: string | undefined;
  readonly passed: boolean;
}

export interface VerificationVerdict {
  readonly verified: boolean;
  readonly reason: string;
}

/**
 * Whether real checks were run **against the resolved tree**.
 *
 * `.research/27 §2.5`, in its own words: always re-run real tests after an
 * agent-assisted resolution rather than trusting the resolution as evidence.
 * The word doing the work is *after*. A merge conflict is resolved by editing
 * files, so the suite that passed before the resolution passed against a tree
 * that no longer exists — and a resolution "verified" by that run is the
 * self-report failure with a green tick in front of it.
 *
 * Absent evidence and failing evidence are reported separately. They call for
 * opposite actions: one means run the checks, the other means the resolution is
 * wrong.
 */
export function resolutionVerified(
  evidence: ResolutionEvidence | null,
  head: { git_sha: string; dirty_tree_hash?: string | undefined },
): VerificationVerdict {
  if (evidence === null) {
    return {
      verified: false,
      reason:
        'no checks have been run since the conflict was resolved — a resolution is a code change, and nothing about it has been tested',
    };
  }

  if (isStale(evidence, head)) {
    return {
      verified: false,
      reason:
        'the evidence predates the resolution — it describes the tree before the conflict was resolved, which is the one tree it cannot speak for',
    };
  }

  return evidence.passed
    ? { verified: true, reason: 'checks ran against the resolved tree and passed' }
    : { verified: false, reason: 'checks ran against the resolved tree and failed' };
}

/** Both sides of a hunk, laid out for whoever (or whatever) is reasoning about it. */
export function explainConflict(hunk: ConflictHunk): string {
  const lines = [
    `Hunk ${String(hunk.index)} at line ${String(hunk.startLine)}:`,
    '',
    `  ${hunk.oursLabel || 'ours'} —`,
    ...hunk.ours.map((line) => `    ${line}`),
  ];

  if (hunk.base !== undefined) {
    lines.push('', '  common ancestor —', ...hunk.base.map((line) => `    ${line}`));
  } else {
    lines.push(
      '',
      '  (no common ancestor recorded — set `merge.conflictStyle = diff3` to see what each side changed, rather than only what each side now says)',
    );
  }

  lines.push(
    '',
    `  ${hunk.theirsLabel || 'theirs'} —`,
    ...hunk.theirs.map((line) => `    ${line}`),
  );
  return lines.join('\n');
}

export function formatReview(review: ResolutionReview, verdict: VerificationVerdict): string {
  const lines: string[] = [];
  for (const finding of review.findings) {
    lines.push(`  [${finding.severity}] ${finding.message}`);
  }
  if (review.findings.length === 0) lines.push('  no structural findings');

  lines.push(
    '',
    verdict.verified ? `✓ ${verdict.reason}` : `✗ ${verdict.reason}`,
    review.structurallyOk && verdict.verified ? 'Resolution accepted.' : 'Resolution not accepted.',
  );
  return lines.join('\n');
}

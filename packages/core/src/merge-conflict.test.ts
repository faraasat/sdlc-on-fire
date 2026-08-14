import { describe, expect, it } from 'vitest';
import {
  classifyResolution,
  explainConflict,
  formatReview,
  hasConflictMarkers,
  parseConflicts,
  resolutionVerified,
  reviewResolution,
  type ConflictHunk,
} from './merge-conflict.js';

/**
 * P2-GIT-02 — merge-conflict resolution.
 *
 * The property under test throughout is that `--ours` does not pass silently.
 * Taking one side wholesale resolves the conflict, removes every marker,
 * compiles, and discards whatever the other side was for — and the file
 * afterwards is indistinguishable from a careful merge. Every check here exists
 * because nothing downstream can tell those two apart.
 */

const CONFLICT = [
  'const config = {',
  '<<<<<<< HEAD',
  '  timeout: 30,',
  '  retries: 3,',
  '||||||| merged common ancestors',
  '  timeout: 10,',
  '=======',
  '  timeout: 60,',
  '>>>>>>> feature/slow-network',
  '};',
  '',
].join('\n');

describe('parseConflicts', () => {
  it('reads a CRLF file, because git on Windows writes one', () => {
    // The failure this pins was not a crash. `<<<<<<<` still matched by prefix,
    // so every hunk parsed; only the divider test is an equality, and
    // `'=======\r' === '======='` is false. The result was a hunk whose "ours"
    // held the entire conflict body and whose "theirs" was empty — a reviewer
    // shown one side of a two-sided disagreement and told that was all of it.
    const crlf = [
      '<<<<<<< HEAD',
      'retries: 3',
      '=======',
      'timeout: 60',
      '>>>>>>> feat/x',
      '',
    ].join('\r\n');

    const [hunk] = parseConflicts(crlf);
    expect(hunk?.ours).toEqual(['retries: 3']);
    expect(hunk?.theirs).toEqual(['timeout: 60']);
    expect(hunk?.oursLabel).toBe('HEAD');
    expect(hunk?.theirsLabel).toBe('feat/x');
  });

  it('reads LF and CRLF to the same hunks', () => {
    const lines = ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> other', ''];
    expect(parseConflicts(lines.join('\r\n'))).toEqual(parseConflicts(lines.join('\n')));
  });

  it('finds a hunk and both sides', () => {
    const [hunk] = parseConflicts(CONFLICT);
    expect(hunk?.ours).toEqual(['  timeout: 30,', '  retries: 3,']);
    expect(hunk?.theirs).toEqual(['  timeout: 60,']);
  });

  it('records the branch labels git wrote', () => {
    const [hunk] = parseConflicts(CONFLICT);
    expect(hunk?.oursLabel).toBe('HEAD');
    expect(hunk?.theirsLabel).toBe('feature/slow-network');
  });

  it('captures the common ancestor under diff3', () => {
    expect(parseConflicts(CONFLICT)[0]?.base).toEqual(['  timeout: 10,']);
  });

  it('leaves base absent, not empty, when the repo is not on diff3', () => {
    // Absent and empty lead to opposite readings of what each side did: no
    // recorded ancestor means the repo does not emit one, while a blank
    // ancestor means both sides added something to nothing.
    const plain = ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> other', ''].join('\n');
    expect(parseConflicts(plain)[0]?.base).toBeUndefined();
  });

  it('reports the line the hunk starts on', () => {
    expect(parseConflicts(CONFLICT)[0]?.startLine).toBe(2);
  });

  it('finds several hunks in one file, in order', () => {
    const two = [
      '<<<<<<< HEAD',
      'a1',
      '=======',
      'b1',
      '>>>>>>> other',
      'middle',
      '<<<<<<< HEAD',
      'a2',
      '=======',
      'b2',
      '>>>>>>> other',
      '',
    ].join('\n');
    const hunks = parseConflicts(two);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((h) => h.index)).toEqual([0, 1]);
    expect(hunks[1]?.ours).toEqual(['a2']);
  });

  it('does not find conflicts in text that merely mentions markers', () => {
    // Conflict bodies routinely contain marker-lookalikes — a diff in a test
    // fixture, a Markdown rule of equals signs. An unanchored pattern reports
    // conflicts in files that have none.
    const prose = [
      'The marker is written `<<<<<<<` and closed with `>>>>>>>`.',
      '=======',
      'A Markdown rule is not a divider.',
      '',
    ].join('\n');
    expect(parseConflicts(prose)).toEqual([]);
    expect(hasConflictMarkers(prose)).toBe(false);
  });

  it('does not let an inline mention swallow the real hunk below it', () => {
    // The discriminating case for anchoring. A file with *no* real conflict
    // returns `[]` whether markers are matched at line start or anywhere on the
    // line, so it cannot tell the two apart. Here an unanchored match opens a
    // hunk on the prose line and eats the genuine `<<<<<<< HEAD` as content —
    // the parse still succeeds, and reports the wrong sides.
    const mixed = [
      "const doc = 'a conflict marker <<<<<<< looks like this';",
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> other',
      '',
    ].join('\n');
    const [hunk] = parseConflicts(mixed);
    expect(hunk?.ours).toEqual(['a']);
    expect(hunk?.startLine).toBe(2);
  });

  it('refuses to report an unterminated hunk as a conflict', () => {
    // A truncated or hand-mangled file. Reporting it well-formed would invite a
    // "resolution" of half a hunk.
    const truncated = ['<<<<<<< HEAD', 'a', '=======', 'b', ''].join('\n');
    expect(parseConflicts(truncated)).toEqual([]);
  });

  it('finds nothing in a clean file', () => {
    expect(parseConflicts('const a = 1;\n')).toEqual([]);
    expect(hasConflictMarkers('const a = 1;\n')).toBe(false);
  });
});

describe('classifyResolution', () => {
  const hunk = parseConflicts(CONFLICT)[0] as ConflictHunk;

  it('names a resolution that kept only our side', () => {
    expect(classifyResolution(hunk, ['  timeout: 30,', '  retries: 3,'])).toBe('ours');
  });

  it('names a resolution that kept only their side', () => {
    expect(classifyResolution(hunk, ['  timeout: 60,'])).toBe('theirs');
  });

  it('names a resolution that kept both', () => {
    expect(classifyResolution(hunk, ['  timeout: 60,', '  retries: 3,'])).toBe('union');
  });

  it('names a resolution containing code from neither side', () => {
    expect(classifyResolution(hunk, ['  timeout: process.env.CI ? 60 : 30,'])).toBe('synthesis');
  });

  it('names a resolution that kept nothing at all', () => {
    expect(classifyResolution(hunk, [])).toBe('neither');
  });

  it('ignores whitespace-only differences', () => {
    expect(classifyResolution(hunk, ['', '  timeout: 60,  ', ''])).toBe('theirs');
  });

  it('does not read a line both sides share as evidence of either', () => {
    // A line present on both sides says nothing about which side was chosen.
    // Counting it as "ours" classifies a dropped side as a *union*, which skips
    // the declaration requirement entirely — so the discriminating case is a
    // resolution that took **theirs** while a shared line survives. Taking ours
    // gives the right answer either way and proves nothing.
    const shared = parseConflicts(
      ['<<<<<<< HEAD', 'same', 'a', '=======', 'same', 'b', '>>>>>>> other', ''].join('\n'),
    )[0] as ConflictHunk;
    expect(classifyResolution(shared, ['same', 'a'])).toBe('ours');
    expect(classifyResolution(shared, ['same', 'b'])).toBe('theirs');
  });
});

describe('reviewResolution', () => {
  const hunks = parseConflicts(CONFLICT);

  it('blocks on markers still in the file', () => {
    const review = reviewResolution(hunks, [['  timeout: 60,']], [], CONFLICT);
    expect(review.structurallyOk).toBe(false);
    expect(review.findings[0]?.message).toContain('not a resolution');
  });

  it('blocks an undeclared dropped side', () => {
    // The whole point. `--ours` compiles, removes every marker, and throws away
    // whatever the other branch was for.
    const review = reviewResolution(hunks, [['  timeout: 30,', '  retries: 3,']]);
    expect(review.structurallyOk).toBe(false);
    expect(review.findings[0]?.message).toContain('indistinguishable from an accident');
  });

  it('allows a declared dropped side', () => {
    // Taking a side is often correct. What is never correct is doing it by
    // accident with nothing recording that a decision was made.
    const review = reviewResolution(
      hunks,
      [['  timeout: 30,', '  retries: 3,']],
      [
        {
          hunk: 0,
          rationale: 'the slow-network timeout was superseded by the retry policy added on main',
        },
      ],
    );
    expect(review.structurallyOk).toBe(true);
    expect(review.findings[0]?.severity).toBe('declare');
  });

  it('does not accept a token rationale', () => {
    const review = reviewResolution(hunks, [['  timeout: 60,']], [{ hunk: 0, rationale: 'ok' }]);
    expect(review.structurallyOk).toBe(false);
  });

  it('needs no declaration for a union', () => {
    // Keeping both sides discards nothing, so there is no decision to record.
    const review = reviewResolution(hunks, [['  timeout: 60,', '  retries: 3,']]);
    expect(review.structurallyOk).toBe(true);
    expect(review.findings).toEqual([]);
  });

  it('blocks a hunk that kept nothing from either side', () => {
    const review = reviewResolution(hunks, [[]], [{ hunk: 0, rationale: 'x'.repeat(40) }]);
    expect(review.structurallyOk).toBe(false);
    expect(review.findings.some((f) => f.message.includes('both changes are gone'))).toBe(true);
  });

  it('blocks undeclared new code written at the merge boundary', () => {
    const review = reviewResolution(hunks, [['  timeout: process.env.CI ? 60 : 30,']]);
    expect(review.structurallyOk).toBe(false);
    expect(review.findings[0]?.message).toContain('least-reviewed code');
  });

  it('allows declared synthesis', () => {
    const review = reviewResolution(
      hunks,
      [['  timeout: process.env.CI ? 60 : 30,']],
      [{ hunk: 0, rationale: 'both sides were right for their environment; branch on it instead' }],
    );
    expect(review.structurallyOk).toBe(true);
  });

  it('matches declarations by hunk index, not by position', () => {
    // A declaration for hunk 1 must not satisfy hunk 0. Otherwise one rationale
    // covers every drop in the file.
    const two = parseConflicts(
      [
        '<<<<<<< HEAD',
        'a1',
        '=======',
        'b1',
        '>>>>>>> other',
        '<<<<<<< HEAD',
        'a2',
        '=======',
        'b2',
        '>>>>>>> other',
        '',
      ].join('\n'),
    );
    const review = reviewResolution(
      two,
      [['a1'], ['a2']],
      [{ hunk: 1, rationale: 'the second hunk was superseded upstream, this one only' }],
    );
    expect(review.findings.filter((f) => f.severity === 'blocking')).toHaveLength(1);
    expect(review.findings.find((f) => f.severity === 'blocking')?.hunk).toBe(0);
  });
});

describe('resolutionVerified', () => {
  const head = { git_sha: 'a'.repeat(40), dirty_tree_hash: 'b'.repeat(64) };

  it('accepts checks that ran against the resolved tree and passed', () => {
    expect(resolutionVerified({ ...head, passed: true }, head).verified).toBe(true);
  });

  it('refuses when no checks have been run at all', () => {
    const verdict = resolutionVerified(null, head);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('nothing about it has been tested');
  });

  it('refuses evidence that predates the resolution', () => {
    // `.research/27 §2.5` says re-run tests *after* the resolution, and `after`
    // is the load-bearing word: the suite that passed before it passed against
    // a tree that no longer exists.
    const verdict = resolutionVerified({ git_sha: 'c'.repeat(40), passed: true }, head);
    expect(verdict.verified).toBe(false);
    expect(verdict.reason).toContain('the one tree it cannot speak for');
  });

  it('refuses evidence from the same commit but a different working tree', () => {
    // Resolving a conflict edits files without committing, so the sha alone
    // cannot tell the pre- and post-resolution trees apart.
    const verdict = resolutionVerified(
      { git_sha: head.git_sha, dirty_tree_hash: 'd'.repeat(64), passed: true },
      head,
    );
    expect(verdict.verified).toBe(false);
  });

  it('distinguishes absent evidence from failing evidence', () => {
    // Opposite actions: one means run the checks, the other means the
    // resolution is wrong.
    expect(resolutionVerified(null, head).reason).not.toBe(
      resolutionVerified({ ...head, passed: false }, head).reason,
    );
    expect(resolutionVerified({ ...head, passed: false }, head).reason).toContain('failed');
  });
});

describe('explainConflict', () => {
  it('lays out both sides and the ancestor', () => {
    const text = explainConflict(parseConflicts(CONFLICT)[0] as ConflictHunk);
    expect(text).toContain('HEAD');
    expect(text).toContain('common ancestor');
    expect(text).toContain('feature/slow-network');
  });

  it('says when no ancestor was recorded rather than showing a blank one', () => {
    const plain = parseConflicts(
      ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> other', ''].join('\n'),
    )[0] as ConflictHunk;
    expect(explainConflict(plain)).toContain('diff3');
  });
});

describe('formatReview', () => {
  it('refuses a structurally clean resolution that nothing has tested', () => {
    // The two checks are independent, and a resolution needs both. A clean
    // shape with no evidence is the exact thing this task exists to refuse.
    const review = reviewResolution(parseConflicts(CONFLICT), [
      ['  timeout: 60,', '  retries: 3,'],
    ]);
    const text = formatReview(review, resolutionVerified(null, { git_sha: 'a'.repeat(40) }));
    expect(review.structurallyOk).toBe(true);
    expect(text).toContain('Resolution not accepted');
  });

  it('accepts only when both the shape and the evidence hold', () => {
    const head = { git_sha: 'a'.repeat(40) };
    const review = reviewResolution(parseConflicts(CONFLICT), [
      ['  timeout: 60,', '  retries: 3,'],
    ]);
    const text = formatReview(review, resolutionVerified({ ...head, passed: true }, head));
    expect(text).toContain('Resolution accepted.');
  });
});

describe('the declared kind is checked against the file (P2-SKILL-07)', () => {
  const hunks = parseConflicts(CONFLICT);

  it('blocks a declaration that disagrees with what was written', () => {
    // The `resolve-conflict` skill reports what it believes it did. An agent
    // claiming `union` while the file kept one side has produced a rationale
    // describing a resolution nobody wrote — and the rationale is the only part
    // a reviewer reads.
    const review = reviewResolution(
      hunks,
      [['  timeout: 30,', '  retries: 3,']],
      [
        {
          hunk: 0,
          kind: 'union',
          rationale: 'kept both the retry policy and the slow-network timeout',
        },
      ],
      '',
      CONFLICT,
    );
    expect(review.structurallyOk).toBe(false);
    expect(review.findings[0]?.message).toContain('not the one on disk');
  });

  it('accepts a declaration that matches', () => {
    const review = reviewResolution(
      hunks,
      [['  timeout: 30,', '  retries: 3,']],
      [
        {
          hunk: 0,
          kind: 'ours',
          rationale: 'the slow-network timeout was superseded by the retry policy on main',
        },
      ],
      '',
      CONFLICT,
    );
    expect(review.structurallyOk).toBe(true);
  });

  it('checks nothing when no kind was claimed', () => {
    // A rationale with no claimed kind is still a valid declaration; the check
    // exists for claims, and inventing one to check would be the guess.
    const review = reviewResolution(
      hunks,
      [['  timeout: 30,', '  retries: 3,']],
      [{ hunk: 0, rationale: 'the slow-network timeout was superseded by the retry policy' }],
      '',
      CONFLICT,
    );
    expect(review.structurallyOk).toBe(true);
  });
});

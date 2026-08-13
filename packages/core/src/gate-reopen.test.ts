import { describe, expect, it } from 'vitest';
import {
  authorizeTerminalWrite,
  contentPreserved,
  formatReopenPlan,
  planReopen,
  REOPENABLE_FIELDS,
  type GateCoverage,
  type TerminalWriteGrounds,
} from './gate-reopen.js';

/**
 * P2-INS-02 — selective gate re-open, and the write that may touch a finished
 * item.
 *
 * Both halves are tested for what they *refuse*. A selective re-open that
 * quietly keeps a gate it could not reason about, and a re-open authorization
 * that lets a finished story's acceptance criteria be rewritten, are the two
 * ways this feature turns into the bug it was built to prevent.
 */

const coverage: readonly GateCoverage[] = [
  { requirementId: 'unit-tests', paths: ['src/'] },
  { requirementId: 'ui-review', paths: ['app/ui/'] },
];

describe('planReopen', () => {
  it('re-opens a requirement whose covered files were touched', () => {
    const plan = planReopen(['unit-tests', 'ui-review'], [{ path: 'src/export/csv.ts' }], coverage);
    expect(plan.reopened).toEqual(['unit-tests']);
    expect(plan.kept).toEqual(['ui-review']);
  });

  it('leaves a requirement standing when nothing it covers moved', () => {
    const plan = planReopen(['ui-review'], [{ path: 'src/export/csv.ts' }], coverage);
    expect(plan.kept).toEqual(['ui-review']);
  });

  it('re-opens a requirement with no declared coverage', () => {
    // The load-bearing default. An undeclared requirement is not one known to
    // be unaffected — it is one nobody described, and reading "we do not know"
    // as "unaffected" is the substitution this product refuses everywhere else.
    const plan = planReopen(['smoke-test'], [{ path: 'src/export/csv.ts' }], coverage);
    expect(plan.reopened).toEqual(['smoke-test']);
    expect(plan.decisions[0]?.reason).toContain('cannot be shown unaffected');
  });

  it('re-opens a requirement whose declared coverage is empty', () => {
    // A declaration that names no paths is a declaration in form only.
    const plan = planReopen(
      ['smoke-test'],
      [{ path: 'src/x.ts' }],
      [{ requirementId: 'smoke-test', paths: [] }],
    );
    expect(plan.reopened).toEqual(['smoke-test']);
  });

  it('matches by prefix, so a directory covers what is under it', () => {
    const plan = planReopen(['unit-tests'], [{ path: 'src/deeply/nested/file.ts' }], coverage);
    expect(plan.reopened).toEqual(['unit-tests']);
  });

  it('re-opens everything for a migrate, whatever the coverage says', () => {
    // P2-LIFE-02: a migration changes data underneath code nobody edited, so
    // the files it touched do not bound what it can break.
    const plan = planReopen(['ui-review'], [{ path: 'src/x.ts' }], coverage, 'migrate');
    expect(plan.reopened).toEqual(['ui-review']);
    expect(plan.decisions[0]?.reason).toContain('underneath code nobody edited');
  });

  it('re-opens everything when a high-risk surface is touched', () => {
    const plan = planReopen(
      ['ui-review'],
      [{ path: 'db/migrations/0008_split.sql' }],
      coverage,
      'feature',
    );
    expect(plan.reopened).toEqual(['ui-review']);
  });

  it('keeps everything standing when nothing changed at all', () => {
    const plan = planReopen(['unit-tests', 'ui-review'], [], coverage);
    expect(plan.reopened).toEqual([]);
  });

  it('names each decision rather than returning a bare count', () => {
    const text = formatReopenPlan(
      planReopen(['unit-tests', 'ui-review'], [{ path: 'src/a.ts' }], coverage),
    );
    expect(text).toContain('unit-tests');
    expect(text).toContain('1 gate(s) re-opened, 1 left standing');
  });
});

describe('contentPreserved', () => {
  const done = {
    id: 'STORY-014',
    lifecycle_state: 'done',
    status: 'Done',
    acceptance_criteria: ['GIVEN a share link WHEN it expires THEN access is refused'],
    updated_at: '2026-01-01T00:00:00Z',
  };

  it('accepts a change confined to operational fields', () => {
    const result = contentPreserved(done, 'body\n', { ...done, status: 'In Review' }, 'body\n');
    expect(result.ok).toBe(true);
  });

  it('refuses a rewritten acceptance criterion', () => {
    // BMAD #1930 in one assertion: correct-course rewrites a completed story's
    // acceptance criteria in place, breaking the link between what the code was
    // reviewed against and what the story now says.
    const result = contentPreserved(
      done,
      'body\n',
      { ...done, acceptance_criteria: ['GIVEN anything THEN it works'] },
      'body\n',
    );
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual(['acceptance_criteria']);
  });

  it('refuses a changed body', () => {
    const result = contentPreserved(done, 'original\n', done, 'rewritten\n');
    expect(result.ok).toBe(false);
    expect(result.bodyChanged).toBe(true);
  });

  it('refuses a field added to a finished item', () => {
    const result = contentPreserved(done, 'body\n', { ...done, spec_ref: 'SPEC-9' }, 'body\n');
    expect(result.changed).toEqual(['spec_ref']);
  });

  it('refuses a field removed from a finished item', () => {
    const { acceptance_criteria: _dropped, ...without } = done;
    expect(contentPreserved(done, 'body\n', without, 'body\n').changed).toEqual([
      'acceptance_criteria',
    ]);
  });

  it('reports every offending field, not the first', () => {
    // A caller told only about one fixes it, retries, and is told about the
    // next — which teaches them the check is a nuisance rather than a rule.
    const result = contentPreserved(
      done,
      'body\n',
      { ...done, acceptance_criteria: ['x'], title: 'renamed' },
      'body\n',
    );
    expect(result.changed).toEqual(['acceptance_criteria', 'title']);
  });

  it('protects by default — the allowlist holds only operational fields', () => {
    // The direction matters more than the contents: a field added to the schema
    // tomorrow is protected without anybody remembering to protect it.
    expect(REOPENABLE_FIELDS.has('lifecycle_state')).toBe(true);
    expect(REOPENABLE_FIELDS.has('status')).toBe(true);
    expect(REOPENABLE_FIELDS.has('acceptance_criteria')).toBe(false);
    expect(REOPENABLE_FIELDS.has('title')).toBe(false);
    expect(REOPENABLE_FIELDS.has('spec_ref')).toBe(false);
    expect(REOPENABLE_FIELDS.has('supersedes')).toBe(false);
  });
});

describe('authorizeTerminalWrite', () => {
  const auth: TerminalWriteGrounds = {
    kind: 'insertion',
    insertionId: 'INSERT-014',
    insertionState: 'approved',
    blastRadius: ['STORY-014', 'FEAT-002'],
    itemId: 'STORY-014',
  };
  const clean = { ok: true, changed: [], bodyChanged: false } as const;

  it('allows a re-open backed by an approved insertion that reaches the item', () => {
    expect(authorizeTerminalWrite(auth, clean).allowed).toBe(true);
  });

  it('refuses a proposed insertion', () => {
    // A proposed insertion is a request. Letting it authorise edits to finished
    // work would mean anyone who can propose can rewrite.
    const verdict = authorizeTerminalWrite({ ...auth, insertionState: 'proposed' }, clean);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('not an authority');
  });

  it('refuses a rejected insertion', () => {
    expect(authorizeTerminalWrite({ ...auth, insertionState: 'rejected' }, clean).allowed).toBe(
      false,
    );
  });

  it('refuses an item outside that insertion’s blast radius', () => {
    // Without this, one approved insertion anywhere authorises editing every
    // terminal item in the repository.
    const verdict = authorizeTerminalWrite({ ...auth, itemId: 'STORY-999' }, clean);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('does not reach this item');
  });

  it('refuses a write that changes content even with a perfect authorization', () => {
    const verdict = authorizeTerminalWrite(auth, {
      ok: false,
      changed: ['acceptance_criteria'],
      bodyChanged: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('supersede or correct');
  });

  it('refuses a write that changes the body even with a perfect authorization', () => {
    const verdict = authorizeTerminalWrite(auth, { ok: false, changed: [], bodyChanged: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('reviewed against');
  });

  it('reports every failing condition at once', () => {
    const verdict = authorizeTerminalWrite(
      { ...auth, insertionState: 'proposed', itemId: 'STORY-999' },
      { ok: false, changed: ['title'], bodyChanged: true },
    );
    expect(verdict.reasons).toHaveLength(4);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BOOKKEEPING_TRAILER,
  buildBranchName,
  classifyChanges,
  isBookkeepingOnly,
  slugify,
  SLUG_MAX_LENGTH,
  withBookkeepingTrailer,
} from './naming.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Add CSV Export')).toBe('add-csv-export');
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(slugify('fix:  the __broken__ thing!')).toBe('fix-the-broken-thing');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  --hello--  ')).toBe('hello');
  });

  it('truncates at a word boundary rather than mid-word', () => {
    const result = slugify('add csv export to the reporting dashboard');
    expect(result.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    // A mid-word cut would leave a trailing partial like "report".
    expect(result).toBe('add-csv-export-to-the');
  });

  it('never ends in a hyphen', () => {
    expect(slugify('a'.repeat(SLUG_MAX_LENGTH + 5))).not.toMatch(/-$/);
  });
});

describe('buildBranchName', () => {
  it('includes the full hierarchy when present', () => {
    expect(
      buildBranchName({
        type: 'feat',
        epic: 'auth',
        feature: 'login',
        taskId: 'P1-GATE-02',
        slug: 'evaluategate',
      }),
    ).toBe('feat/auth-login-P1-GATE-02-evaluategate');
  });

  it('omits hierarchy segments the item does not have', () => {
    expect(buildBranchName({ type: 'fix', taskId: 'BUG-042', slug: 'header row' })).toBe(
      'fix/BUG-042-header-row',
    );
  });

  it('preserves the task ID verbatim', () => {
    // Lowercasing the anchor would break `git log --grep=P0-GIT-01`.
    expect(buildBranchName({ type: 'feat', taskId: 'P0-GIT-01', slug: 'git manager' })).toContain(
      'P0-GIT-01',
    );
  });

  it('slugifies the hierarchy segments', () => {
    expect(buildBranchName({ type: 'feat', epic: 'User Auth', taskId: 'T-1', slug: 'x' })).toBe(
      'feat/user-auth-T-1-x',
    );
  });
});

describe('classifyChanges', () => {
  it('separates managed workspace paths from product code', () => {
    const result = classifyChanges([
      'kanban/tasks/TASK-001.md',
      'docs/architecture.md',
      'src/index.ts',
      'package.json',
    ]);
    expect(result.managed).toEqual(['kanban/tasks/TASK-001.md', 'docs/architecture.md']);
    expect(result.product).toEqual(['src/index.ts', 'package.json']);
  });

  it('recognises the pre-ADR-0043 .sdlc/ layout', () => {
    expect(classifyChanges(['.sdlc/tasks/TASK-001.md']).managed).toHaveLength(1);
  });

  it('normalises separators and leading ./', () => {
    expect(classifyChanges(['./kanban/x.md']).managed).toEqual(['kanban/x.md']);
    expect(classifyChanges(['kanban\\x.md']).managed).toEqual(['kanban/x.md']);
  });

  it('does not treat a lookalike prefix as managed', () => {
    // `docs-site/` is not `docs/`.
    expect(classifyChanges(['docs-site/index.html']).product).toEqual(['docs-site/index.html']);
  });

  it('honours custom prefixes', () => {
    expect(classifyChanges(['wiki/a.md'], ['wiki/']).managed).toEqual(['wiki/a.md']);
  });
});

describe('isBookkeepingOnly', () => {
  it('is true when only managed paths changed', () => {
    expect(isBookkeepingOnly(['kanban/tasks/TASK-001.md'])).toBe(true);
  });

  it('is false when any product code changed', () => {
    expect(isBookkeepingOnly(['kanban/tasks/TASK-001.md', 'src/index.ts'])).toBe(false);
  });

  it('is false for an empty change set', () => {
    // Nothing changed is not bookkeeping — an empty commit must not acquire a
    // trailer claiming it moved workspace state.
    expect(isBookkeepingOnly([])).toBe(false);
  });
});

describe('withBookkeepingTrailer', () => {
  it('appends the trailer after a blank line', () => {
    expect(withBookkeepingTrailer('chore(sdlc): mark TASK-001 in_review')).toBe(
      `chore(sdlc): mark TASK-001 in_review\n\n${BOOKKEEPING_TRAILER}`,
    );
  });

  it('is idempotent', () => {
    const once = withBookkeepingTrailer('msg');
    expect(withBookkeepingTrailer(once)).toBe(once);
  });

  it('does not duplicate a hand-written trailer', () => {
    const message = `msg\n\n${BOOKKEEPING_TRAILER}`;
    expect(withBookkeepingTrailer(message).match(/Sdlc-Bookkeeping/g)).toHaveLength(1);
  });
});

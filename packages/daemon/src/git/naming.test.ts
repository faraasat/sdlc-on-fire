import { describe, expect, it } from 'vitest';
import {
  assistedByTrailer,
  isPinnedModelId,
  readProvenance,
  withTrailers,
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

describe('provenance trailers (P1-GIT-01)', () => {
  it('records the tool and model without claiming co-authorship', () => {
    const line = assistedByTrailer({ tool: 'Claude-Code', model: 'claude-opus-4-5-20260101' });
    expect(line).toBe('Assisted-by: Claude-Code:claude-opus-4-5-20260101');
    // The distinction is the whole point: `Co-authored-by` asserts shared
    // accountability, and a model cannot be accountable for anything.
    expect(line.toLowerCase()).not.toContain('co-authored-by');
  });

  it('refuses a model id that carries no version', () => {
    expect(() => assistedByTrailer({ tool: 'Claude-Code', model: 'claude-opus' })).toThrow(
      /not a version-pinned model id/,
    );
    expect(isPinnedModelId('claude-opus-4-5-20260101')).toBe(true);
    expect(isPinnedModelId('gpt-5.2-2026-03-11')).toBe(true);
  });

  it('accepts a dateless generation id, and this is a deliberate loosening', () => {
    // `gpt-5` used to be REFUSED here, as a bare family name. It is accepted now,
    // and the trade is worth naming: refusing it also refused `claude-opus-5`,
    // which Anthropic's docs state is its own pinned snapshot — so the old rule
    // rejected the trailer for the model that actually wrote this commit.
    //
    // We lose the ability to catch a vendor whose dateless id is a moving
    // pointer. We cannot get it back from the string: `claude-opus-5` is a
    // snapshot and `claude-haiku-4-5` is an alias, identical in shape. The only
    // alternative is a vendor allowlist, which goes stale faster than the models
    // do — the reasoning the original comment already gave (P6-SURFACE-14).
    expect(isPinnedModelId('claude-opus-5')).toBe(true);
    expect(isPinnedModelId('gpt-5')).toBe(true);
    expect(isPinnedModelId('claude-opus')).toBe(false);
  });

  it('renders the trailer for the current top-tier model', () => {
    // The defect this closes, verified on the built daemon before the fix:
    // `naming.ts` carried its own copy of the rule, `core`'s copy was corrected
    // and this one was not, and the result was that provenance for
    // `claude-opus-5` was refused while `sdlc agents` routed to it.
    expect(assistedByTrailer({ tool: 'claude-code', model: 'claude-opus-5' })).toBe(
      'Assisted-by: claude-code:claude-opus-5',
    );
  });

  it('keeps every trailer in one block, so git can still read the first', () => {
    const message = withTrailers('feat: thing\n\nbody', [
      BOOKKEEPING_TRAILER,
      'Assisted-by: Claude-Code:claude-opus-4-5-20260101',
    ]);
    const paragraphs = message.split(/\n\s*\n/);
    // Git only parses trailers from the last paragraph. Two blocks would make
    // the earlier trailer invisible to `git log --format=%(trailers)`.
    expect(paragraphs.at(-1)).toBe(
      `${BOOKKEEPING_TRAILER}\nAssisted-by: Claude-Code:claude-opus-4-5-20260101`,
    );
  });

  it('merges into an existing trailer block rather than starting a second one', () => {
    // The realistic case: a caller hand-writes a trailer, and the manager adds
    // provenance later. Two paragraphs would leave the hand-written one
    // invisible to `git log --format=%(trailers)`, which is a silent loss.
    const authored = `feat: thing\n\nbody\n\n${BOOKKEEPING_TRAILER}`;
    const message = withTrailers(authored, ['Assisted-by: Claude-Code:m-2026-01-01']);
    expect(message.split(/\n\s*\n/)).toHaveLength(3);
    expect(message.split(/\n\s*\n/).at(-1)).toBe(
      `${BOOKKEEPING_TRAILER}\nAssisted-by: Claude-Code:m-2026-01-01`,
    );
  });

  it('is idempotent — a commit does not declare two assistants', () => {
    const once = withTrailers('feat: thing\n\nbody', ['Assisted-by: Claude-Code:m-2026-01-01']);
    const twice = withTrailers(once, ['Assisted-by: Claude-Code:m-2026-01-01']);
    expect(twice).toBe(once);
  });

  it('does not mistake a prose paragraph for a trailer block', () => {
    // "Note: this is prose" parses as a trailer line on its own; a paragraph is
    // only a trailer block when *every* line is one.
    const message = withTrailers('feat: thing\n\nNote: careful here\nbecause it wraps', [
      BOOKKEEPING_TRAILER,
    ]);
    expect(message.endsWith(`because it wraps\n\n${BOOKKEEPING_TRAILER}`)).toBe(true);
  });

  it('reads provenance back out of a message', () => {
    const message = withTrailers('fix: thing', [
      BOOKKEEPING_TRAILER,
      'Assisted-by: Claude-Code:claude-opus-4-5-20260101',
    ]);
    expect(readProvenance(message)).toEqual([
      { tool: 'Claude-Code', model: 'claude-opus-4-5-20260101' },
    ]);
  });
});

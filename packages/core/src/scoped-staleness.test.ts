import { describe, expect, it } from 'vitest';
import { scopedStaleness } from './evidence.js';

/**
 * Scoped staleness (P8-EVID-02, Q-08, contracts/03 §5.3a).
 *
 * Every test names the wrong answer it prevents. The dangerous direction here
 * is uniform: keeping evidence that should have been thrown away, because the
 * whole feature exists to keep evidence longer.
 */

const envelope = { git_sha: 'a'.repeat(40) };
const moved = { git_sha: 'b'.repeat(40) };
const exempt = {
  scopeExempt: true,
  covers: ['src/core.ts', 'src/util.ts'],
  ancestor: true,
  changedPaths: ['README.md'],
};

describe('scopedStaleness', () => {
  it('is current when the tree has not moved at all', () => {
    const result = scopedStaleness(envelope, envelope, { ...exempt, changedPaths: [] });
    expect(result.verdict).toBe('current');
  });

  it('keeps expensive evidence when the diff misses everything it covers', () => {
    expect(scopedStaleness(envelope, moved, exempt).verdict).toBe('current-by-scope');
  });

  it('discards it the moment one covered path changes', () => {
    const result = scopedStaleness(envelope, moved, {
      ...exempt,
      changedPaths: ['README.md', 'src/util.ts'],
    });
    expect(result.verdict).toBe('stale');
    expect(result.touched).toEqual(['src/util.ts']);
  });

  it('does not exempt a kind the policy did not mark exempt', () => {
    // Opt-in, never a default. For a cheap signal, re-running is cheaper than
    // reasoning about scope, and a scope rule that is wrong is worse than a
    // re-run.
    const result = scopedStaleness(envelope, moved, { ...exempt, scopeExempt: false });
    expect(result.verdict).toBe('stale');
    expect(result.because).toContain('not scope-exempt');
  });

  it('treats a missing covers list as unknown coverage, not as universal freshness', () => {
    // The reassuring reading of a missing field is the one that silently keeps
    // every expensive result forever.
    for (const covers of [undefined, []]) {
      expect(scopedStaleness(envelope, moved, { ...exempt, covers }).verdict).toBe('stale');
    }
  });

  it('refuses when the evidence commit is not an ancestor of HEAD', () => {
    // After a rebase or force-push the commit the evidence names is not in this
    // history, so there is no range to diff and no honest way to say what
    // changed. Accepting it would keep evidence about a tree that no longer
    // exists — and the changed-path list would look reassuringly short.
    const result = scopedStaleness(envelope, moved, {
      ...exempt,
      ancestor: false,
      changedPaths: [],
    });
    expect(result.verdict).toBe('stale');
    expect(result.because).toContain('not an ancestor');
  });

  it('refuses when the working tree is dirty, whatever the commit range says', () => {
    // An uncommitted edit is in no commit range, so a clean-looking diff proves
    // nothing about it.
    const result = scopedStaleness(envelope, { ...moved, dirty_tree_hash: 'c'.repeat(64) }, exempt);
    expect(result.verdict).toBe('stale');
    expect(result.because).toContain('uncommitted');
  });

  it('says how many paths it checked, so the exemption can be interrogated', () => {
    // Evidence surviving a commit is exactly the thing a reviewer must be able
    // to question rather than take on trust.
    const result = scopedStaleness(envelope, moved, {
      ...exempt,
      changedPaths: ['README.md', 'docs/a.md'],
    });
    expect(result.because).toContain('2 path(s) changed');
    expect(result.because).toContain('none of the 2 this evidence covers');
  });

  it('matches paths exactly rather than by prefix', () => {
    // A prefix match would make `src/core.ts.bak` invalidate `src/core.ts`, and
    // — far worse in the other direction — a covered `src/` would swallow paths
    // nobody meant to cover.
    const result = scopedStaleness(envelope, moved, {
      ...exempt,
      changedPaths: ['src/core.ts.bak'],
    });
    expect(result.verdict).toBe('current-by-scope');
  });

  it('names every covered path the diff touched, not just the first', () => {
    const result = scopedStaleness(envelope, moved, {
      ...exempt,
      changedPaths: ['src/util.ts', 'src/core.ts'],
    });
    expect([...result.touched].sort()).toEqual(['src/core.ts', 'src/util.ts']);
  });
});

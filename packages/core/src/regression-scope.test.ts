import { describe, expect, it } from 'vitest';
import { resolveRequiredStages } from './lifecycle.js';
import { mayRunSelective, regressionScopeFor } from './regression-scope.js';

/**
 * P2-LIFE-02 — `migrate` as a work type distinct from `refactor`.
 *
 * The distinction is the deliverable, so the tests are written as the contrast
 * rather than as two independent checks.
 */

describe('the refactor / migrate contrast', () => {
  it('exists as two separate work types in every preset', () => {
    for (const preset of ['lite', 'standard', 'strict'] as const) {
      expect(resolveRequiredStages(preset, 'refactor')).not.toBeNull();
      expect(resolveRequiredStages(preset, 'migrate')).not.toBeNull();
    }
  });

  it('gives migrate a plan stage that refactor does not get, in every preset', () => {
    // A refactor is undone with a revert. A migration that has already run
    // against real data is not, and the plan stage is where the rollback path
    // gets written down while it is still cheap to write.
    //
    // Asserted across all three presets rather than one: the rollback argument
    // does not weaken because a team chose `lite`, and a version of this test
    // that checked only `standard` left the other two rows unpinned.
    for (const preset of ['lite', 'standard', 'strict'] as const) {
      expect(resolveRequiredStages(preset, 'migrate')).toContain('plan');
      expect(resolveRequiredStages(preset, 'refactor')).not.toContain('plan');
    }
  });

  it('gives migrate a security review under strict, and refactor none', () => {
    expect(resolveRequiredStages('strict', 'migrate')).toContain('security_review');
    expect(resolveRequiredStages('strict', 'refactor')).not.toContain('security_review');
  });

  it('forces full regression for migrate and allows selective for refactor', () => {
    // The load-bearing difference. A refactor's blast radius really is the
    // files it touched. A column rename breaks every query in the system and
    // not one of those files appears in the diff.
    expect(regressionScopeFor('migrate').scope).toBe('full');
    expect(regressionScopeFor('refactor').scope).toBe('selective');
    expect(mayRunSelective('refactor')).toBe(true);
    expect(mayRunSelective('migrate')).toBe(false);
  });

  it('explains why, in terms somebody can act on', () => {
    expect(regressionScopeFor('migrate').reason).toContain('blast radius');
  });
});

describe('regressionScopeFor — high-risk surfaces override the work type', () => {
  it('forces full regression on a schema change inside an ordinary feature', () => {
    const decision = regressionScopeFor('feature', [
      {
        path: 'db/migrations/003_rename.sql',
        addedContent: 'ALTER TABLE users DROP COLUMN email;',
      },
    ]);
    // Keying only on work type would let a migration through by relabelling it.
    expect(decision.scope).toBe('full');
    expect(decision.reason).toContain('migrations');
  });

  it('forces full regression on an auth change', () => {
    expect(regressionScopeFor('feature', [{ path: 'src/auth/session.ts' }]).scope).toBe('full');
  });

  it('forces full regression on a payments change', () => {
    expect(regressionScopeFor('task', [{ path: 'src/billing/charge.ts' }]).scope).toBe('full');
  });

  it('does not force full regression on an ordinary change', () => {
    const decision = regressionScopeFor('feature', [
      { path: 'src/components/Button.tsx', addedContent: 'export const Button = () => null;' },
    ]);
    expect(decision.scope).toBe('selective');
  });

  it('does not force full regression merely for calling an external API', () => {
    // `external-api` is a high-risk *review* surface, not a blast-radius one —
    // adding a fetch does not invalidate tests elsewhere, and treating every
    // risk surface as a full-regression trigger would make selective re-run
    // apply to almost nothing.
    const decision = regressionScopeFor('feature', [
      { path: 'src/lib/sync.ts', addedContent: 'const r = await fetch(url);' },
    ]);
    expect(decision.scope).toBe('selective');
  });

  it('defaults to selective with no changed files', () => {
    expect(regressionScopeFor('feature').scope).toBe('selective');
  });
});

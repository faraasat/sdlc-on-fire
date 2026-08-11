import { describe, expect, it } from 'vitest';
import { resolveRequiredStages } from './lifecycle.js';
import {
  formatTriage,
  isBreaking,
  orderByUrgency,
  triageUpgrade,
  type UpgradeChange,
} from './upgrade-triage.js';

/**
 * P2-LIFE-01 — the `dependency-upgrade` work type and its triage.
 *
 * The problem being solved is not "is this package safe" — that is the install
 * gate's question. It is that bot PRs arrive faster than anyone reviews them,
 * so a security patch sits unmerged next to forty README-badge bumps.
 */

const change = (over: Partial<UpgradeChange> = {}): UpgradeChange => ({
  name: 'lodash',
  from: '4.17.20',
  to: '4.17.21',
  ...over,
});

describe('the dependency-upgrade stage subset', () => {
  it('exists in every preset', () => {
    for (const preset of ['lite', 'standard', 'strict'] as const) {
      expect(resolveRequiredStages(preset, 'dependency-upgrade')).not.toBeNull();
    }
  });

  it('keeps `test` even in lite, where a plain task skips it', () => {
    // The whole point of the work type: the diff was written by a bot and
    // nobody is reading the library's internals, so the regression evidence
    // *is* the deliverable.
    expect(resolveRequiredStages('lite', 'dependency-upgrade')).toContain('test');
    expect(resolveRequiredStages('lite', 'task')).not.toContain('test');
  });

  it('drops the ceremony that made teams route bot PRs around the process', () => {
    const stages = resolveRequiredStages('standard', 'dependency-upgrade') ?? [];
    for (const skipped of ['discovery', 'spec', 'decompose', 'plan']) {
      expect(stages).not.toContain(skipped);
    }
  });

  it('keeps security_review under strict', () => {
    // A dependency upgrade is a supply-chain event, and the 2026 incident
    // record is entirely composed of version bumps that looked routine.
    expect(resolveRequiredStages('strict', 'dependency-upgrade')).toContain('security_review');
  });

  it('keeps implement, so a breaking bump has somewhere to be adapted', () => {
    // A stage passed straight through costs less than a stage you cannot enter
    // when you turn out to need it.
    expect(resolveRequiredStages('lite', 'dependency-upgrade')).toContain('implement');
  });
});

describe('isBreaking', () => {
  it('is true across a major boundary', () => {
    expect(isBreaking('1.9.9', '2.0.0')).toBe(true);
    expect(isBreaking('2.0.0', '1.9.9')).toBe(true);
  });

  it('is false for a compatible bump', () => {
    expect(isBreaking('4.17.20', '4.17.21')).toBe(false);
    expect(isBreaking('1.2.0', '1.9.0')).toBe(false);
  });

  it('treats a 0.x minor bump as breaking', () => {
    // What semver actually says, and what every team learns the hard way:
    // pre-1.0 packages break on minor bumps by design.
    expect(isBreaking('0.4.0', '0.5.0')).toBe(true);
    expect(isBreaking('0.4.0', '0.4.1')).toBe(false);
  });

  it('treats an unparseable version as breaking', () => {
    // A git dependency or a tag is not evidence of safety, and it should get a
    // human rather than a shrug.
    expect(isBreaking('git#abc123', '1.0.0')).toBe(true);
    expect(isBreaking('1.0.0', 'next')).toBe(true);
  });

  it('tolerates a v prefix', () => {
    expect(isBreaking('v1.2.3', 'v1.2.4')).toBe(false);
  });
});

describe('triageUpgrade', () => {
  it('ranks an advisory fix as security', () => {
    const triage = triageUpgrade([change({ fixesAdvisories: ['GHSA-aaa'] })]);
    expect(triage.urgency).toBe('security');
    expect(triage.reason).toContain('GHSA-aaa');
    expect(triage.needsReview).toBe(true);
  });

  it('ranks security above a breaking change in the same set', () => {
    const triage = triageUpgrade([
      change({ name: 'a', from: '1.0.0', to: '2.0.0' }),
      change({ name: 'b', fixesAdvisories: ['GHSA-bbb'] }),
    ]);
    expect(triage.urgency).toBe('security');
    // …and the breaking change is still reported, because it still has to be
    // dealt with.
    expect(triage.breaking.map((c) => c.name)).toEqual(['a']);
  });

  it('ranks a breaking bump as major', () => {
    const triage = triageUpgrade([change({ from: '1.0.0', to: '2.0.0' })]);
    expect(triage.urgency).toBe('major');
    expect(triage.needsReview).toBe(true);
  });

  it('lets a compatible bump through without a person', () => {
    const triage = triageUpgrade([change()]);
    expect(triage.urgency).toBe('routine');
    // It still goes through the work type's `test` stage — that is where the
    // evidence comes from — but it does not need attention before it gets there.
    expect(triage.needsReview).toBe(false);
  });

  it('asks for a human when it found no changes at all', () => {
    const triage = triageUpgrade([]);
    // An empty change set means the parser found nothing, not that nothing
    // changed — and those need opposite responses.
    expect(triage.needsReview).toBe(true);
  });
});

describe('orderByUrgency', () => {
  it('puts security first and routine last', () => {
    const items = [
      { id: 'c', triage: triageUpgrade([change()]) },
      { id: 'a', triage: triageUpgrade([change({ from: '1.0.0', to: '2.0.0' })]) },
      { id: 'b', triage: triageUpgrade([change({ fixesAdvisories: ['GHSA-x'] })]) },
    ];
    expect(orderByUrgency(items).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('is stable within a band', () => {
    const items = [
      { id: 'z', triage: triageUpgrade([change()]) },
      { id: 'a', triage: triageUpgrade([change()]) },
    ];
    // A queue re-sorted twice must read the same both times.
    expect(orderByUrgency(items).map((i) => i.id)).toEqual(['a', 'z']);
    expect(orderByUrgency(orderByUrgency(items)).map((i) => i.id)).toEqual(['a', 'z']);
  });
});

describe('formatTriage', () => {
  it('marks which changes are the breaking ones', () => {
    const text = formatTriage(
      triageUpgrade([change({ name: 'a', from: '1.0.0', to: '2.0.0' }), change({ name: 'b' })]),
    );
    expect(text).toContain('a 1.0.0 → 2.0.0 (breaking)');
    expect(text).not.toContain('b 4.17.20 → 4.17.21 (breaking)');
  });

  it('says a security upgrade is not exempt from the gate', () => {
    const text = formatTriage(triageUpgrade([change({ fixesAdvisories: ['GHSA-x'] })]));
    // Fixing one advisory by installing a version carrying a different one is a
    // real outcome.
    expect(text).toContain('install gate still runs');
  });
});

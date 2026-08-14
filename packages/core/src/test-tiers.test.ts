import { describe, expect, it } from 'vitest';
import {
  evaluateTiers,
  extraTiers,
  formatTierReport,
  REQUIRED_TIERS,
  TEST_TIERS,
  TIER_DEFINITIONS,
  tierOf,
  type TierRun,
} from './test-tiers.js';

/**
 * P2-QA-01 — test tiers.
 *
 * The property under test is that a tier which never ran does not read as a
 * tier that passed. A unit suite green while the integration suite was never
 * wired up is the normal shape of a broken seam — every part correct, nothing
 * connected — and no envelope stream says so, because a run that did not happen
 * produces no envelope.
 */

describe('tierOf', () => {
  it('places each tier from its filename', () => {
    expect(tierOf('src/parse.test.ts')).toBe('unit');
    expect(tierOf('src/adapter.integration.test.ts')).toBe('integration');
    expect(tierOf('src/boot.smoke.test.ts')).toBe('smoke');
    expect(tierOf('src/issue-412.regression.test.ts')).toBe('regression');
    expect(tierOf('src/checkout.e2e.test.ts')).toBe('e2e');
  });

  it('places a file by its directory too', () => {
    expect(tierOf('tests/integration/storage.ts')).toBe('integration');
    expect(tierOf('tests/e2e/flow.ts')).toBe('e2e');
  });

  it('does not read a specific tier as a unit test', () => {
    // `a.smoke.test.ts` also ends in `.test.`, so a naive ordering counts it as
    // a unit test — and the smoke tier then silently never runs while the
    // report says it did.
    expect(tierOf('a.smoke.test.ts')).not.toBe('unit');
    expect(tierOf('a.integration.test.ts')).not.toBe('unit');
    expect(tierOf('a.e2e.test.ts')).not.toBe('unit');
  });

  it('accepts .spec. as well as .test.', () => {
    expect(tierOf('src/parse.spec.ts')).toBe('unit');
    expect(tierOf('src/api.integration.spec.ts')).toBe('integration');
  });

  it('normalises Windows separators', () => {
    expect(tierOf('tests\\integration\\storage.ts')).toBe('integration');
  });

  it('returns null for a file that is not a test', () => {
    // Not a default of `unit`: guessing would inflate the unit tier with things
    // that are not unit tests, and make an unrecognised naming scheme look like
    // coverage of a tier nobody wrote.
    expect(tierOf('src/index.ts')).toBeNull();
    expect(tierOf('README.md')).toBeNull();
    expect(tierOf('src/testing-utils.ts')).toBeNull();
  });

  it('covers every declared tier with a definition', () => {
    expect(TIER_DEFINITIONS.map((d) => d.tier).sort()).toEqual([...TEST_TIERS].sort());
  });
});

describe('REQUIRED_TIERS', () => {
  it('is additive as the preset tightens', () => {
    // A preset that dropped a tier the level below demanded would make
    // "stricter" a claim rather than a fact.
    const lite = new Set(REQUIRED_TIERS['lite']);
    const standard = new Set(REQUIRED_TIERS['standard']);
    const strict = new Set(REQUIRED_TIERS['strict']);

    for (const tier of lite) expect(standard.has(tier), `standard drops ${tier}`).toBe(true);
    for (const tier of standard) expect(strict.has(tier), `strict drops ${tier}`).toBe(true);
  });

  it('asks lite for the cycle that makes TDD possible, and nothing else', () => {
    expect(REQUIRED_TIERS['lite']).toEqual(['unit']);
  });

  it('reserves e2e for strict', () => {
    expect(REQUIRED_TIERS['standard']).not.toContain('e2e');
    expect(REQUIRED_TIERS['strict']).toContain('e2e');
  });
});

describe('evaluateTiers', () => {
  const passing = (tier: TierRun['tier'], total = 10): TierRun => ({
    tier,
    total,
    passed: total,
    failed: 0,
  });

  it('is satisfied when every required tier ran and passed', () => {
    const report = evaluateTiers('standard', [
      passing('unit'),
      passing('integration'),
      passing('regression'),
    ]);
    expect(report.satisfied).toBe(true);
  });

  it('reports a tier that never ran as missing, not as passing', () => {
    // The whole point. No envelope looks exactly like nothing to worry about.
    const report = evaluateTiers('standard', [passing('unit'), passing('regression')]);
    expect(report.satisfied).toBe(false);
    const integration = report.findings.find((f) => f.tier === 'integration');
    expect(integration?.status).toBe('missing');
    expect(integration?.detail).toContain('is not a tier that passed');
  });

  it('distinguishes missing from failed', () => {
    // They ask for opposite work: one means fix the code, the other means write
    // or wire up the tests.
    const missing = evaluateTiers('lite', []);
    const failed = evaluateTiers('lite', [{ tier: 'unit', total: 10, passed: 9, failed: 1 }]);
    expect(missing.findings[0]?.status).toBe('missing');
    expect(failed.findings[0]?.status).toBe('failed');
  });

  it('refuses a tier that ran zero tests', () => {
    // A runner that matched no files exits 0, and exit 0 with no assertions is
    // the most convincing-looking nothing in software.
    const report = evaluateTiers('lite', [{ tier: 'unit', total: 0, passed: 0, failed: 0 }]);
    expect(report.satisfied).toBe(false);
    expect(report.findings[0]?.status).toBe('empty');
    expect(report.findings[0]?.detail).toContain('not the same as passing');
  });

  it('does not let a passing tier cover for a missing one', () => {
    const report = evaluateTiers('standard', [passing('unit', 5_000)]);
    expect(report.satisfied).toBe(false);
    expect(report.findings.filter((f) => f.status === 'missing').map((f) => f.tier)).toEqual([
      'integration',
      'regression',
    ]);
  });

  it('reports every unmet tier, not the first', () => {
    const report = evaluateTiers('strict', [passing('unit')]);
    expect(report.findings.filter((f) => f.status !== 'passed')).toHaveLength(4);
  });

  it('falls back to standard for an unknown preset rather than requiring nothing', () => {
    // An unrecognised preset asking for no tiers would make a typo the
    // cheapest way through the gate.
    const report = evaluateTiers('nonsense', []);
    expect(report.satisfied).toBe(false);
    expect(report.findings.map((f) => f.tier)).toEqual(['unit', 'integration', 'regression']);
  });
});

describe('extraTiers', () => {
  it('names tiers that ran without being required', () => {
    const extra = extraTiers('standard', [
      { tier: 'unit', total: 1, passed: 1, failed: 0 },
      { tier: 'e2e', total: 3, passed: 3, failed: 0 },
    ]);
    expect(extra).toEqual(['e2e']);
  });

  it('does not treat doing more than required as a problem', () => {
    const runs: TierRun[] = [
      { tier: 'unit', total: 1, passed: 1, failed: 0 },
      { tier: 'integration', total: 1, passed: 1, failed: 0 },
      { tier: 'regression', total: 1, passed: 1, failed: 0 },
      { tier: 'e2e', total: 1, passed: 1, failed: 0 },
    ];
    expect(evaluateTiers('standard', runs).satisfied).toBe(true);
    expect(extraTiers('standard', runs)).toEqual(['e2e']);
  });
});

describe('formatTierReport', () => {
  it('marks missing and empty differently from failed', () => {
    const text = formatTierReport(
      'standard',
      evaluateTiers('standard', [
        { tier: 'unit', total: 0, passed: 0, failed: 0 },
        { tier: 'regression', total: 2, passed: 1, failed: 1 },
      ]),
    );
    expect(text).toContain('⚠ unit');
    expect(text).toContain('· integration');
    expect(text).toContain('✗ regression');
    expect(text).toContain('not satisfied');
  });

  it('says plainly when everything required ran', () => {
    const text = formatTierReport(
      'lite',
      evaluateTiers('lite', [{ tier: 'unit', total: 4, passed: 4, failed: 0 }]),
    );
    expect(text).toContain('Every required tier ran and passed.');
  });
});

describe('discovery mode (P2-QA-07)', () => {
  const files = [{ tier: 'unit' as const, total: 85, passed: 0, failed: 0 }];

  it('never says a discovered tier passed', () => {
    // The defect this closes: `sdlc tiers` synthesised a run per tier from a
    // *file count* and rendered it through the run formatter, printing
    // "85/85 unit tests passed" for a suite it had never executed. This
    // product exists to refuse that sentence from an agent, and it was
    // producing it about itself. Found by running the built binary against an
    // unrelated repository.
    const report = evaluateTiers('standard', files, 'discovery');
    const unit = report.findings.find((finding) => finding.tier === 'unit');
    expect(unit?.status).toBe('present');
    expect(unit?.detail).toContain('not run, so not passing');
    expect(unit?.detail).not.toContain('passed —');
  });

  it('is never satisfied by files alone', () => {
    // Listing files cannot satisfy a tier requirement, whatever the count.
    expect(evaluateTiers('standard', files, 'discovery').satisfied).toBe(false);
  });

  it('says nothing was run', () => {
    const text = formatTierReport('standard', evaluateTiers('standard', files, 'discovery'));
    expect(text).toContain('Nothing was run.');
    expect(text).not.toContain('ran and passed');
  });

  it('still reports a real run in the language of a run', () => {
    // The other mode is unchanged: an actual run still says passed.
    const ran = [{ tier: 'unit' as const, total: 85, passed: 85, failed: 0 }];
    expect(formatTierReport('standard', evaluateTiers('standard', ran))).toContain(
      '85/85 unit tests passed',
    );
  });

  it('describes a missing tier as absent files, not as an absent run', () => {
    const report = evaluateTiers('standard', files, 'discovery');
    const integration = report.findings.find((finding) => finding.tier === 'integration');
    expect(integration?.detail).toBe('no integration test files found');
  });
});

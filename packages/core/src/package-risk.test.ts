import { describe, expect, it } from 'vitest';
import {
  classifyPackage,
  editDistance,
  looksLikeTyposquat,
  RISK_THRESHOLDS,
  type PackageSignals,
} from './package-risk.js';

/**
 * P2-SEC-01 — package legitimacy classification.
 *
 * The attack being stopped is slopsquatting: a model names a package that does
 * not exist, someone registers that name, and the next agent installs it. So
 * the tests that matter are the two directions of being wrong — waving through
 * a lure, and striking a legitimate new package.
 */

const signals = (over: Partial<PackageSignals> = {}): PackageSignals => ({
  name: 'left-pad',
  ecosystem: 'npm',
  advisories: [],
  ageDays: 3000,
  monthlyDownloads: 5_000_000,
  repositoryVerified: true,
  ...over,
});

describe('editDistance', () => {
  it('measures single edits', () => {
    expect(editDistance('lodash', 'lodahs')).toBe(2);
    expect(editDistance('react', 'raect')).toBe(2);
    expect(editDistance('chalk', 'chal')).toBe(1);
    expect(editDistance('same', 'same')).toBe(0);
  });
});

describe('looksLikeTyposquat', () => {
  it('flags a near-name with a thousandfold download gap', () => {
    expect(
      looksLikeTyposquat(
        signals({
          name: 'lodahs',
          monthlyDownloads: 40,
          nearestPopularName: 'lodash',
          nearestPopularDownloads: 60_000_000,
        }),
      ),
    ).toBe(true);
  });

  it('does not flag two comparably popular packages with near-identical names', () => {
    // `q` and `qs` are both real, both heavily depended on, and one edit apart —
    // so this pair reaches the download-ratio comparison and can only be cleared
    // by it. (The first version of this test used `lodash`/`lodash-es`, which is
    // three edits apart: it returned false at the distance check and asserted
    // nothing about the ratio at all. Deleting the ratio comparison entirely
    // left it green.)
    expect(
      looksLikeTyposquat(
        signals({
          name: 'qs',
          monthlyDownloads: 50_000_000,
          nearestPopularName: 'q',
          nearestPopularDownloads: 10_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('is not fooled by a lure that is merely less popular, without the gap', () => {
    // Just below its neighbour is ordinary — most packages are. The rule is a
    // thousandfold gap, and a boundary that drifts down turns every second-place
    // package into an accusation.
    expect(
      looksLikeTyposquat(
        signals({
          name: 'lodahs',
          monthlyDownloads: 100_000,
          nearestPopularName: 'lodash',
          nearestPopularDownloads: 60_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('does not flag a name that is merely thematically similar', () => {
    expect(
      looksLikeTyposquat(
        signals({
          name: 'completely-different',
          monthlyDownloads: 10,
          nearestPopularName: 'lodash',
          nearestPopularDownloads: 60_000_000,
        }),
      ),
    ).toBe(false);
  });

  it('ignores a package compared against itself', () => {
    expect(looksLikeTyposquat(signals({ name: 'lodash', nearestPopularName: 'lodash' }))).toBe(
      false,
    );
  });
});

describe('classifyPackage', () => {
  it('clears an established package', () => {
    expect(classifyPackage(signals()).verdict).toBe('ok');
  });

  it('strikes a package with a live advisory', () => {
    const result = classifyPackage(signals({ advisories: ['GHSA-xxxx-yyyy'], version: '1.0.0' }));
    expect(result.verdict).toBe('slop');
    expect(result.reasons[0]).toContain('GHSA-xxxx-yyyy');
  });

  it('strikes a quantified typosquat', () => {
    const result = classifyPackage(
      signals({
        name: 'lodahs',
        monthlyDownloads: 40,
        ageDays: 2,
        repositoryVerified: false,
        nearestPopularName: 'lodash',
        nearestPopularDownloads: 60_000_000,
      }),
    );
    expect(result.verdict).toBe('slop');
    expect(result.reasons.join(' ')).toContain('edits of "lodash"');
  });

  it('says "assumed" when nothing is known, never "ok"', () => {
    const result = classifyPackage({ name: 'mystery', ecosystem: 'npm', advisories: [] });
    // An offline check that silently passes converts "we did not look" into
    // "we looked and it was fine" — the exact substitution this product
    // refuses. Fail closed.
    expect(result.verdict).toBe('assumed');
    expect(result.reasons[0]).toContain('not as safe');
  });

  it('does not strike a legitimate brand-new package on age alone', () => {
    // Every legitimate package published this week is young and unpopular. One
    // soft signal has to stay ordinary, or the tool cries wolf into disuse.
    const result = classifyPackage(
      signals({ ageDays: 2, monthlyDownloads: 5_000_000, repositoryVerified: true }),
    );
    expect(result.verdict).toBe('ok');
  });

  it('flags for review when two soft signals stack', () => {
    const result = classifyPackage(
      signals({ ageDays: 2, monthlyDownloads: 10, repositoryVerified: true }),
    );
    // Young AND unused is the shape worth a human's attention — and it is `sus`,
    // not `slop`: a wrong strike deletes a real dependency from a plan.
    expect(result.verdict).toBe('sus');
    expect(result.reasons).toHaveLength(2);
  });

  it('counts an unverified repository as one of the stacking signals', () => {
    const result = classifyPackage(
      signals({ ageDays: 2, monthlyDownloads: 5_000_000, repositoryVerified: false }),
    );
    expect(result.verdict).toBe('sus');
  });

  it('keeps its thresholds nameable rather than inlined', () => {
    // They are starting values, not measurements — .research/14 warns that
    // GSD's numbers are tuned to GSD's corpus. One place to change, one to cite.
    expect(RISK_THRESHOLDS.typosquatDistance).toBe(2);
    expect(RISK_THRESHOLDS.typosquatDownloadRatio).toBe(1000);
  });

  it('refuses signals carrying an unknown field', () => {
    expect(() =>
      classifyPackage({ name: 'x', ecosystem: 'npm', advisories: [], trustMe: true } as never),
    ).toThrow();
  });
});

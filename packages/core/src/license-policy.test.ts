import { describe, expect, it } from 'vitest';
import { assessLicense, classifyLicense, evaluateLicenseGate } from './license-policy.js';

/** P2-SEC-08 — license-compatibility classification. */

describe('classifyLicense', () => {
  const cases: readonly [string, string][] = [
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['BSD-3-Clause', 'permissive'],
    ['ISC', 'permissive'],
    ['CC0-1.0', 'public-domain'],
    ['MPL-2.0', 'weak-copyleft'],
    ['LGPL-3.0-or-later', 'weak-copyleft'],
    ['GPL-3.0', 'strong-copyleft'],
    ['GPL-2.0-only', 'strong-copyleft'],
    ['AGPL-3.0', 'network-copyleft'],
    ['SSPL-1.0', 'network-copyleft'],
    ['BUSL-1.1', 'proprietary'],
  ];

  for (const [expression, expected] of cases) {
    it(`classifies ${expression} as ${expected}`, () => {
      expect(classifyLicense(expression)).toBe(expected);
    });
  }

  it('is case-insensitive', () => {
    expect(classifyLicense('mit')).toBe('permissive');
    expect(classifyLicense('AgPl-3.0')).toBe('network-copyleft');
  });

  it('treats a missing license as unknown, never as permissive', () => {
    // Same fail-closed shape as the advisory check: a missing field means
    // nobody looked, and reading that as "no obligations" turns silence into
    // consent.
    expect(classifyLicense(undefined)).toBe('unknown');
    expect(classifyLicense(null)).toBe('unknown');
    expect(classifyLicense('')).toBe('unknown');
    expect(classifyLicense('   ')).toBe('unknown');
  });

  it('treats an unrecognised identifier as unknown', () => {
    expect(classifyLicense('SEE LICENSE IN LICENSE.txt')).toBe('unknown');
  });
});

describe('classifyLicense — SPDX expressions', () => {
  it('takes the permissive side of a choice', () => {
    // `(MIT OR GPL-3.0)` is an offer of either. A project may take the MIT
    // side, so flagging it would flag every dual-licensed package in the
    // ecosystem.
    expect(classifyLicense('(MIT OR GPL-3.0)')).toBe('permissive');
    expect(classifyLicense('MIT OR Apache-2.0')).toBe('permissive');
  });

  it('takes the worst term of a conjunction', () => {
    // `MIT AND GPL-3.0` means every obligation applies. Collapsing this with
    // the OR case would wave through a genuine conjunction.
    expect(classifyLicense('MIT AND GPL-3.0')).toBe('strong-copyleft');
  });

  it('handles a WITH exception without losing the base license', () => {
    expect(classifyLicense('GPL-2.0-only WITH Classpath-exception-2.0')).toBe('strong-copyleft');
  });

  it('ignores a trailing +', () => {
    expect(classifyLicense('GPL-3.0+')).toBe('strong-copyleft');
  });
});

describe('assessLicense', () => {
  it('flags GPL against an MIT project', () => {
    const assessment = assessLicense('some-lib', 'GPL-3.0', 'MIT');
    expect(assessment.flagged).toBe(true);
    expect(assessment.reason).toContain('derived works');
  });

  it('calls out AGPL as triggering on serving, not distributing', () => {
    const assessment = assessLicense('some-lib', 'AGPL-3.0', 'MIT');
    // The distinction that catches hosted software: a team that correctly
    // reasoned "we never ship binaries" is exactly who AGPL surprises.
    expect(assessment.reason).toContain('serving');
  });

  it('does not flag a permissive dependency', () => {
    expect(assessLicense('some-lib', 'MIT', 'MIT').flagged).toBe(false);
    expect(assessLicense('some-lib', 'Apache-2.0', 'MIT').flagged).toBe(false);
  });

  it('flags an undeclared license', () => {
    const assessment = assessLicense('some-lib', undefined, 'MIT');
    expect(assessment.flagged).toBe(true);
    expect(assessment.reason).toContain('unreviewed');
    expect(assessment.license).toBe('(none declared)');
  });

  it('does not warn a GPL project about its GPL dependencies', () => {
    // The obligation it would be warned about is one it has already taken on.
    expect(assessLicense('some-lib', 'GPL-3.0', 'GPL-3.0').flagged).toBe(false);
    // …but AGPL is still stronger than GPL, so it still asks.
    expect(assessLicense('some-lib', 'AGPL-3.0', 'GPL-3.0').flagged).toBe(true);
  });

  it('still asks about an unknown license under a copyleft project', () => {
    // `unknown` is not "less severe than GPL" — it is unmeasured, and an
    // unmeasured thing cannot be cleared by comparison.
    expect(assessLicense('some-lib', undefined, 'GPL-3.0').flagged).toBe(true);
  });
});

describe('evaluateLicenseGate', () => {
  const of = (name: string, license?: string) => assessLicense(name, license, 'MIT');

  it('is clean when everything is permissive', () => {
    const result = evaluateLicenseGate([of('a', 'MIT'), of('b', 'Apache-2.0')]);
    expect(result.decision).toBe('clean');
    expect(result.flagged).toEqual([]);
  });

  it('never blocks, only asks', () => {
    // A license question has a legal dimension. Refusing outright on a table
    // lookup would assert a conclusion this tool is not equipped to reach.
    const result = evaluateLicenseGate([of('a', 'AGPL-3.0')]);
    expect(result.decision).toBe('needs-human');
    expect(['needs-human', 'clean']).toContain(result.decision);
  });

  it('orders the worst obligation first', () => {
    const result = evaluateLicenseGate([
      of('a', 'MPL-2.0'),
      of('b', 'AGPL-3.0'),
      of('c', 'GPL-3.0'),
    ]);
    // Someone reading a long list reads the top of it.
    expect(result.flagged.map((f) => f.class)).toEqual([
      'network-copyleft',
      'strong-copyleft',
      'weak-copyleft',
    ]);
  });

  it('names the package and its license in every reason', () => {
    const result = evaluateLicenseGate([of('some-lib', 'GPL-3.0')]);
    expect(result.reasons[0]).toContain('some-lib');
    expect(result.reasons[0]).toContain('GPL-3.0');
  });

  it('is clean for an empty set', () => {
    expect(evaluateLicenseGate([]).decision).toBe('clean');
  });
});

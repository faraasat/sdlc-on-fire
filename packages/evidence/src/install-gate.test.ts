import { describe, expect, it } from 'vitest';
import type { PackageAssessment } from '@sdlc-on-fire/core';
import { evaluateInstallGate, formatInstallGate, mayAutoRetryInstall } from './install-gate.js';

/**
 * P2-SEC-01 — the install approval gate.
 *
 * The distinction under test is between *refusing* and *offering for approval*.
 * A package with a live advisory must never appear in a list somebody might
 * wave through; everything softer must reach a human rather than be decided by
 * a score nobody has measured.
 */

const assess = (
  name: string,
  verdict: PackageAssessment['verdict'],
  reasons: string[] = [],
): PackageAssessment => ({ name, ecosystem: 'npm', verdict, reasons });

describe('evaluateInstallGate', () => {
  it('blocks outright when any package is slop', () => {
    const result = evaluateInstallGate([
      assess('lodash', 'ok'),
      assess('lodahs', 'slop', ['typosquat of lodash']),
    ]);
    expect(result.decision).toBe('blocked');
    expect(result.struck.map((s) => s.name)).toEqual(['lodahs']);
    // Refused, not offered — the treatment must not depend on the reviewer
    // being alert at the end of a long day.
    expect(result.reasons.join(' ')).toContain('REFUSED');
  });

  it('requires a human when a package is merely suspicious', () => {
    const result = evaluateInstallGate([assess('newthing', 'sus', ['2 days old', '10 downloads'])]);
    expect(result.decision).toBe('needs-human');
    expect(result.review.map((r) => r.name)).toEqual(['newthing']);
  });

  it('requires a human when nothing could be looked up', () => {
    // `assumed` is the offline case. It must ask, not wave through.
    expect(evaluateInstallGate([assess('mystery', 'assumed')]).decision).toBe('needs-human');
  });

  it('still requires a human when everything cleared', () => {
    const result = evaluateInstallGate([assess('lodash', 'ok'), assess('react', 'ok')]);
    // The shipped default is that a human sees any install. The classifier
    // makes the approval informed; it does not replace it.
    expect(result.decision).toBe('needs-human');
    expect(result.reasons.join(' ')).toContain('not yet measured');
  });

  it('lets a workspace opt out of blanket approval, but only explicitly', () => {
    const result = evaluateInstallGate([assess('lodash', 'ok')], { approveEveryInstall: false });
    expect(result.decision).toBe('allowed');
  });

  it('never lets an opt-out override a strike', () => {
    const result = evaluateInstallGate([assess('lodahs', 'slop', ['typosquat'])], {
      approveEveryInstall: false,
    });
    // Opting out of routine approval is a convenience decision. It cannot be a
    // route around a conclusion.
    expect(result.decision).toBe('blocked');
  });

  it('still asks about a suspicious package under the opt-out', () => {
    const result = evaluateInstallGate([assess('newthing', 'sus', ['young', 'unused'])], {
      approveEveryInstall: false,
    });
    expect(result.decision).toBe('needs-human');
  });

  it('allows an empty install list', () => {
    expect(evaluateInstallGate([]).decision).toBe('allowed');
  });

  it('reports the worst finding first', () => {
    const result = evaluateInstallGate([
      assess('fine', 'ok'),
      assess('unknown', 'assumed'),
      assess('bad', 'slop', ['advisory']),
      assess('iffy', 'sus', ['young']),
    ]);
    // A reader scanning the top of the output should meet the strike, not a
    // clean package.
    expect(result.reasons[0]).toContain('bad');
  });
});

describe('mayAutoRetryInstall', () => {
  it('is always no', () => {
    // "Try a similarly-named package instead" is precisely the auto-recovery a
    // squatted near-miss name needs. A function rather than a comment, so the
    // rule is importable and this test can exist at all.
    expect(mayAutoRetryInstall()).toBe(false);
  });
});

describe('formatInstallGate', () => {
  it('leads with the decision', () => {
    expect(formatInstallGate(evaluateInstallGate([assess('bad', 'slop', ['x'])]))).toContain(
      'BLOCKED',
    );
    expect(formatInstallGate(evaluateInstallGate([assess('ok', 'ok')]))).toContain(
      'needs human approval',
    );
  });
});

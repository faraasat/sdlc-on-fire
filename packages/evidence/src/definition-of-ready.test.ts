import { describe, expect, it } from 'vitest';
import {
  evaluateReadiness,
  formatReadiness,
  isAdmissibleOverride,
  isScoredCriterion,
  type ReadinessInput,
} from './definition-of-ready.js';

/**
 * P1-GATE-07 — Definition of Ready (ADR-0031).
 *
 * The gate is soft on purpose, so the tests that matter are about the two ways
 * a soft gate fails: it either blocks a judgment call it has no business
 * blocking, or it becomes a warning everyone clicks through.
 */

const ready: ReadinessInput = {
  id: 'FEAT-001',
  preset: 'standard',
  acceptanceCriteria: ['The importer MUST retry three times before failing.'],
  nonGoals: ['multi-currency'],
  blockedBy: [],
  resolvedBlockers: [],
};

describe('isScoredCriterion', () => {
  it('accepts an RFC-2119 keyword in capitals', () => {
    expect(isScoredCriterion('The importer MUST retry.')).toBe(true);
    expect(isScoredCriterion('Retries SHOULD NOT exceed three.')).toBe(true);
  });

  it('accepts GIVEN/WHEN/THEN', () => {
    expect(isScoredCriterion('GIVEN a table WHEN exported THEN a .csv is written')).toBe(true);
  });

  it('rejects a lowercase "should"', () => {
    // RFC 2119 says capitals, and a lowercase "should" is ordinary English that
    // appears in half of all prose. Accepting it would score every sentence and
    // make the check report success on anything.
    expect(isScoredCriterion('the importer should retry a few times')).toBe(false);
  });
});

describe('evaluateReadiness', () => {
  it('passes a well-formed card', () => {
    const verdict = evaluateReadiness(ready);
    expect(verdict.ready).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('flags missing acceptance criteria', () => {
    const verdict = evaluateReadiness({ ...ready, acceptanceCriteria: [] });
    expect(verdict.findings.map((finding) => finding.check)).toContain(
      'acceptance-criteria-present',
    );
  });

  it('flags criteria that state a wish rather than a requirement', () => {
    const verdict = evaluateReadiness({
      ...ready,
      acceptanceCriteria: ['it should probably handle CSV'],
    });
    const finding = verdict.findings.find((entry) => entry.check === 'acceptance-criteria-scored');
    expect(finding?.detail).toContain('CSV');
  });

  it('flags an empty non-goals list', () => {
    const verdict = evaluateReadiness({ ...ready, nonGoals: [] });
    expect(verdict.findings.map((finding) => finding.check)).toContain('non-goals-present');
  });

  it('flags an unresolved blocker', () => {
    const verdict = evaluateReadiness({ ...ready, blockedBy: ['TASK-009'], resolvedBlockers: [] });
    expect(verdict.findings.map((finding) => finding.check)).toContain('blockers-resolved');
  });

  it('accepts a blocker that finished', () => {
    const verdict = evaluateReadiness({
      ...ready,
      blockedBy: ['TASK-009'],
      resolvedBlockers: ['TASK-009'],
    });
    expect(verdict.ready).toBe(true);
  });

  it('accepts an unresolved blocker the author explicitly accepted', () => {
    const verdict = evaluateReadiness({
      ...ready,
      blockedBy: ['TASK-009'],
      resolvedBlockers: [],
      acceptedBlockers: { 'TASK-009': 'the API contract is already agreed in writing' },
    });
    expect(verdict.ready).toBe(true);
  });

  it('does not accept a blocker "accepted" with an empty reason', () => {
    const verdict = evaluateReadiness({
      ...ready,
      blockedBy: ['TASK-009'],
      resolvedBlockers: [],
      acceptedBlockers: { 'TASK-009': '   ' },
    });
    // A boolean override is one keystroke and tells the next reader nothing.
    expect(verdict.ready).toBe(false);
  });

  it('flags a reference that points at nothing', () => {
    const verdict = evaluateReadiness({
      ...ready,
      references: [
        { ref: 'docs/spec.md', resolves: true },
        { ref: 'docs/gone.md', resolves: false },
      ],
    });
    const finding = verdict.findings.find((entry) => entry.check === 'references-resolve');
    // An agent reads a dangling reference as context that exists.
    expect(finding?.detail).toContain('gone.md');
  });

  it('reports every finding at once, not the first', () => {
    const verdict = evaluateReadiness({
      ...ready,
      acceptanceCriteria: [],
      nonGoals: [],
      blockedBy: ['TASK-009'],
    });
    expect(verdict.findings).toHaveLength(3);
  });
});

describe('softness', () => {
  const notReady = { ...ready, nonGoals: [] };

  it('warns rather than blocks under lite and standard', () => {
    for (const preset of ['lite', 'standard'] as const) {
      const verdict = evaluateReadiness({ ...notReady, preset });
      expect(verdict.ready).toBe(false);
      // "Ready" means understood, not verifiable. Holding it to the evidence
      // gate's bar would block a judgment a machine cannot make.
      expect(verdict.blocked).toBe(false);
    }
  });

  it('blocks under strict, where the workspace asked for it', () => {
    const verdict = evaluateReadiness({ ...notReady, preset: 'strict' });
    expect(verdict.blocked).toBe(true);
  });

  it('names the remedy in every finding', () => {
    const verdict = evaluateReadiness({
      ...ready,
      acceptanceCriteria: [],
      nonGoals: [],
      blockedBy: ['X'],
      references: [{ ref: 'a.md', resolves: false }],
    });
    // A warning with no remedy is noise, and noise is what gets clicked through.
    for (const finding of verdict.findings) expect(finding.remedy.length).toBeGreaterThan(10);
  });
});

describe('overrides', () => {
  const base = { workItemId: 'FEAT-001', actor: 'ana', findings: ['non-goals-present'] };

  it('refuses an empty reason', () => {
    expect(isAdmissibleOverride({ ...base, reason: '' })).toBe(false);
  });

  it('refuses a gesture', () => {
    // ADR-0031 names rubber-stamping as the failure mode. The point is not to
    // make overriding hard — it is to make it cost one sentence, which is the
    // difference between a decision and a reflex.
    expect(isAdmissibleOverride({ ...base, reason: 'ok' })).toBe(false);
    expect(isAdmissibleOverride({ ...base, reason: 'fine, ship it' })).toBe(false);
  });

  it('accepts a real reason', () => {
    expect(
      isAdmissibleOverride({
        ...base,
        reason: 'scope is fixed by the contract we already signed',
      }),
    ).toBe(true);
  });
});

describe('formatReadiness', () => {
  it('says the gate is a signal when it only warns', () => {
    const text = formatReadiness(evaluateReadiness({ ...ready, nonGoals: [] }));
    expect(text).toContain('not a wall');
  });

  it('says the workspace chose to block when it blocks', () => {
    const text = formatReadiness(evaluateReadiness({ ...ready, nonGoals: [], preset: 'strict' }));
    expect(text).toContain('strict preset');
  });
});

describe('enforcement without the strict preset (ADR-0067)', () => {
  it('blocks when the workspace enabled the capability', () => {
    const verdict = evaluateReadiness({ ...ready, nonGoals: [], preset: 'lite', enforce: true });
    // Turning the gate on is a different statement from choosing strict. Both
    // reach the same place; neither implies the other.
    expect(verdict.blocked).toBe(true);
  });

  it('still only warns when it is off', () => {
    const verdict = evaluateReadiness({ ...ready, nonGoals: [], preset: 'lite', enforce: false });
    expect(verdict.blocked).toBe(false);
  });
});

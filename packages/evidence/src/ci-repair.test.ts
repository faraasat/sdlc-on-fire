import { describe, expect, it } from 'vitest';
import type { GateVerdict } from './evaluate-gate.js';
import {
  formatRepairJudgement,
  MAX_REPAIR_ATTEMPTS,
  repairEntryFor,
  repairExhausted,
  repairIsLegitimate,
  type TestInventory,
} from './ci-repair.js';

/**
 * P2-SKILL-05 — the `ci-repair` entry path.
 *
 * Two things under test: that a failed gate opens the *right kind* of work, and
 * that a repair cannot make the gate pass by deleting what was checking.
 */

const verdict = (over: Partial<GateVerdict> = {}): GateVerdict => ({
  pass: false,
  missing: [],
  failures: [],
  abstained: [],
  ...over,
});

const inventory = (over: Partial<TestInventory> = {}): TestInventory => ({
  files: ['a.test.ts', 'b.test.ts'],
  cases: 40,
  assertions: 120,
  ...over,
});

describe('repairEntryFor', () => {
  it('opens nothing when the gate passed', () => {
    expect(repairEntryFor(verdict({ pass: true }))).toBeNull();
  });

  it('opens fix-the-code work for a failing check', () => {
    const entry = repairEntryFor(verdict({ failures: ['test'] }));
    expect(entry?.kind).toBe('fix-the-code');
    expect(entry?.rationale).toContain('not to the check');
  });

  it('opens run-the-check work when evidence is merely absent', () => {
    const entry = repairEntryFor(verdict({ missing: ['typecheck'] }));
    // "Nobody ran it" and "it ran and failed" need different work. Collapsing
    // them produces an agent editing code when the real problem was a check
    // that never executed.
    expect(entry?.kind).toBe('run-the-check');
    expect(entry?.rationale).toContain('Nothing is known to be broken');
  });

  it('opens supply-context work when the verifier abstained', () => {
    const entry = repairEntryFor(verdict({ abstained: ['review'] }));
    expect(entry?.kind).toBe('supply-context');
    // Editing code in response to an abstention changes something that was
    // never shown to be wrong.
    expect(entry?.rationale).toContain('never shown to be wrong');
  });

  it('leads with the failing check when several buckets are populated', () => {
    const entry = repairEntryFor(
      verdict({ failures: ['test'], missing: ['build'], abstained: ['review'] }),
    );
    // The most actionable thing on the list: the tool already said what is
    // wrong.
    expect(entry?.kind).toBe('fix-the-code');
  });

  it('names the work item in the title when one is given', () => {
    const entry = repairEntryFor(verdict({ failures: ['test'] }), { workItemId: 'FEAT-014' });
    expect(entry?.title).toContain('FEAT-014');
  });

  it('stops opening work past the attempt ceiling', () => {
    // A repair loop with no ceiling is an agent burning tokens against a
    // failure it has already failed to understand twice.
    expect(
      repairEntryFor(verdict({ failures: ['test'] }), { attempt: MAX_REPAIR_ATTEMPTS }),
    ).not.toBeNull();
    expect(
      repairEntryFor(verdict({ failures: ['test'] }), { attempt: MAX_REPAIR_ATTEMPTS + 1 }),
    ).toBeNull();
  });

  it('carries the attempt number so the loop is visible', () => {
    expect(repairEntryFor(verdict({ failures: ['test'] }), { attempt: 2 })?.attempt).toBe(2);
  });
});

describe('repairExhausted', () => {
  it('separates "nothing to do" from "this needs a human"', () => {
    // Both make repairEntryFor return null, and reading one as the other is
    // how a stuck gate goes quiet instead of escalating.
    expect(repairExhausted(verdict({ pass: true }), 99)).toBe(false);
    expect(repairExhausted(verdict({ failures: ['test'] }), MAX_REPAIR_ATTEMPTS + 1)).toBe(true);
    expect(repairExhausted(verdict({ failures: ['test'] }), 1)).toBe(false);
  });
});

describe('repairIsLegitimate', () => {
  it('accepts a repair that left the suite intact', () => {
    expect(repairIsLegitimate(inventory(), inventory()).legitimate).toBe(true);
  });

  it('accepts a repair that added tests', () => {
    // Repairs legitimately add regression tests, and treating that as
    // suspicious would discourage the one habit worth encouraging.
    const after = inventory({ files: ['a.test.ts', 'b.test.ts', 'c.test.ts'], cases: 45 });
    expect(repairIsLegitimate(inventory(), after).legitimate).toBe(true);
  });

  it('refuses a repair that deleted a test file', () => {
    // The cheapest available action when asked to make CI green.
    const judgement = repairIsLegitimate(inventory(), inventory({ files: ['a.test.ts'] }));
    expect(judgement.legitimate).toBe(false);
    expect(judgement.reasons[0]).toContain('b.test.ts');
  });

  it('refuses a repair that reduced the test count', () => {
    const judgement = repairIsLegitimate(inventory(), inventory({ cases: 39 }));
    expect(judgement.legitimate).toBe(false);
    expect(judgement.reasons[0]).toContain('smaller suite is not a passing one');
  });

  it('refuses a repair that only dropped assertions', () => {
    // The subtler version: the test still exists and still runs, but the
    // assertion that failed was commented out.
    const judgement = repairIsLegitimate(inventory(), inventory({ assertions: 100 }));
    expect(judgement.legitimate).toBe(false);
    expect(judgement.reasons[0]).toContain('assertion count');
  });

  it('does not guess when the runner reports no assertion count', () => {
    const before = inventory({ assertions: undefined });
    const after = inventory({ assertions: undefined });
    expect(repairIsLegitimate(before, after).legitimate).toBe(true);
  });

  it('reports every reason, not just the first', () => {
    const judgement = repairIsLegitimate(
      inventory(),
      inventory({ files: ['a.test.ts'], cases: 20, assertions: 60 }),
    );
    expect(judgement.reasons).toHaveLength(3);
  });
});

describe('formatRepairJudgement', () => {
  it('says why a refusal cannot be left to review', () => {
    const text = formatRepairJudgement(repairIsLegitimate(inventory(), inventory({ cases: 1 })));
    expect(text).toContain('REFUSED');
    expect(text).toContain('indistinguishable from a real fix');
  });

  it('confirms a clean repair plainly', () => {
    expect(formatRepairJudgement(repairIsLegitimate(inventory(), inventory()))).toContain(
      'did not shrink the suite',
    );
  });
});

describe('the ways a suite shrinks with no count falling (P3-GATE-10)', () => {
  const base = { files: ['a.test.ts'], cases: 10, assertions: 40, skipped: 0, matchedFiles: 1 };

  it('catches tests marked skip', () => {
    // The cheapest evasion the total-comparing checks cannot see: the case is
    // still in the file, still counted, and not run.
    const verdict = repairIsLegitimate(base, { ...base, skipped: 4 });
    expect(verdict.legitimate).toBe(false);
    expect(verdict.reasons[0]).toContain('skipped tests rose');
  });

  it('catches a run that became filtered', () => {
    const verdict = repairIsLegitimate(base, { ...base, filtered: true });
    expect(verdict.legitimate).toBe(false);
    expect(verdict.reasons[0]).toContain('run less');
  });

  it('catches a narrowed glob', () => {
    // The suite did not shrink; the net did.
    expect(
      repairIsLegitimate({ ...base, matchedFiles: 12 }, { ...base, matchedFiles: 3 }).legitimate,
    ).toBe(false);
  });

  it('does not complain when a run was already filtered', () => {
    // A project that always runs a subset is not repairing its way there.
    expect(
      repairIsLegitimate({ ...base, filtered: true }, { ...base, filtered: true }).legitimate,
    ).toBe(true);
  });

  it('does not complain when skips fall', () => {
    // Un-skipping is the good direction and must not read as suspicious.
    expect(repairIsLegitimate({ ...base, skipped: 5 }, { ...base, skipped: 1 }).legitimate).toBe(
      true,
    );
  });

  it('still passes a repair that only adds tests', () => {
    expect(
      repairIsLegitimate(base, { ...base, cases: 14, assertions: 55, matchedFiles: 2 }).legitimate,
    ).toBe(true);
  });

  it('reports every reason, not the first', () => {
    // A repair that did three of these did three of them, and a reviewer
    // shown one will fix one.
    const verdict = repairIsLegitimate(base, {
      ...base,
      skipped: 3,
      filtered: true,
      matchedFiles: 0,
    });
    expect(verdict.reasons.length).toBeGreaterThanOrEqual(3);
  });
});

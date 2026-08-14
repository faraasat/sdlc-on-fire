import { describe, expect, it } from 'vitest';
import {
  evaluatePilot,
  formatPilotVerdict,
  PILOT_CRITERIA,
  type PilotObservation,
  type PilotReport,
} from './pilot.js';

/**
 * P2-QA-07 — the pilot that cannot be self-certified.
 *
 * ADR-0064 requires the four criteria be "measured, not asserted". Every case
 * here is a way a pilot report reads as a pass while demonstrating nothing: it
 * says so rather than shows so, it was run against us, it spans three states of
 * the repository, or it reports a week with no friction at all.
 */

const observed = (criterion: (typeof PILOT_CRITERIA)[number]): PilotObservation => ({
  criterion,
  kind: 'command-output',
  detail: `sdlc ${criterion} → recorded output`,
  atCommit: 'abc1234',
});

const report = (overrides: Partial<PilotReport> = {}): PilotReport => ({
  repository: 'github.com/someone/ordinary-app',
  maintainer: 'someone',
  observations: PILOT_CRITERIA.map(observed),
  friction: [{ summary: 'init asked twice about the docs dir', workItemId: 'BUG-014' }],
  ...overrides,
});

describe('evaluatePilot', () => {
  it('passes a pilot that measured all four criteria on one commit', () => {
    const verdict = evaluatePilot(report());
    expect(verdict.ok).toBe(true);
    expect(verdict.met).toEqual([...PILOT_CRITERIA]);
  });

  it('refuses a criterion that was asserted rather than measured', () => {
    // The sentence a program cannot check, and the one a person under deadline
    // can always write.
    const verdict = evaluatePilot(
      report({
        observations: [
          { ...observed('init-no-surgery'), kind: 'assertion', detail: 'init worked fine' },
          ...PILOT_CRITERIA.slice(1).map(observed),
        ],
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.met).not.toContain('init-no-surgery');
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('only asserted');
  });

  it('refuses a criterion nobody observed at all', () => {
    const verdict = evaluatePilot({
      ...report(),
      observations: PILOT_CRITERIA.slice(1).map(observed),
    });
    expect(verdict.findings.map((f) => f.criterion)).toContain('init-no-surgery');
    // And says so. Falling through to "only asserted" would send the reader to
    // look for an observation that was never written.
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('not observed at all');
  });

  it('requires both halves of the adoption bar', () => {
    // A pilot showing only blocks has demonstrated a gate that says no, which
    // is trivial; one showing only passes has demonstrated nothing at all.
    const blocksOnly = evaluatePilot(
      report({
        observations: PILOT_CRITERIA.filter((c) => c !== 'gate-passed-real-work').map(observed),
      }),
    );
    expect(blocksOnly.met).not.toContain('gate-passed-real-work');

    const passesOnly = evaluatePilot(
      report({
        observations: PILOT_CRITERIA.filter((c) => c !== 'gate-blocked-wrong-done').map(observed),
      }),
    );
    expect(passesOnly.met).not.toContain('gate-blocked-wrong-done');
  });

  it('refuses a pilot run against this project', () => {
    // The whole point is a repository that is not this one — the property most
    // likely to be quietly satisfied by our own repo under time pressure.
    const verdict = evaluatePilot(report({ repository: 'github.com/faraasat/sdlc-on-fire' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('this project');
  });

  it('refuses an unnamed repository or maintainer', () => {
    expect(evaluatePilot(report({ repository: '  ' })).ok).toBe(false);
    // A pilot criterion is "a maintainer willing to report friction honestly",
    // and an anonymous one cannot be asked anything afterwards.
    expect(evaluatePilot(report({ maintainer: '' })).ok).toBe(false);
  });

  it('refuses observations spread across several commits', () => {
    // Four criteria met against three states of the repository is four
    // half-pilots.
    const verdict = evaluatePilot(
      report({
        observations: PILOT_CRITERIA.map((criterion, index) => ({
          ...observed(criterion),
          atCommit: `commit-${String(index)}`,
        })),
      }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('not a best-of');
  });

  it('refuses a measurement with no commit recorded', () => {
    const verdict = evaluatePilot(
      report({
        observations: [
          { ...observed('init-no-surgery'), atCommit: '' },
          ...PILOT_CRITERIA.slice(1).map(observed),
        ],
      }),
    );
    expect(verdict.met).not.toContain('init-no-surgery');
  });

  it('treats a pilot with no friction as unrecorded, not as clean', () => {
    // A real project run by a real person produces friction. An empty list
    // means it was dismissed.
    const verdict = evaluatePilot(report({ friction: [] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain(
      'dismissed rather than captured',
    );
  });

  it('names friction that never became a work item', () => {
    const verdict = evaluatePilot(report({ friction: [{ summary: 'the watcher was noisy' }] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.map((f) => f.message).join(' ')).toContain('the watcher was noisy');
  });

  it('says plainly that the release stays blocked', () => {
    const failing = report({ friction: [] });
    expect(formatPilotVerdict(failing, evaluatePilot(failing))).toContain(
      'the public release stays blocked',
    );
  });

  it('says plainly when the gate is satisfied', () => {
    expect(formatPilotVerdict(report(), evaluatePilot(report()))).toContain(
      'The public-release gate this blocks is satisfied',
    );
  });
});

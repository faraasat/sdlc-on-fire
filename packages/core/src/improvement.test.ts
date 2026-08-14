import { describe, expect, it } from 'vitest';
import {
  evaluateProposal,
  formatProposalVerdict,
  mineTraces,
  MIN_OCCURRENCES,
  protectedFilesTouched,
  PROTECTED_SURFACES,
  type Approval,
  type ImprovementProposal,
  type TraceRecord,
  type ValidationRun,
} from './improvement.js';

/**
 * P2-SKILL-04 — the line between a self-improving harness and RSI.
 *
 * ADR-0026 calls the human-merge step "the single most important design
 * decision in this ADR". These cases are the four ways that step gets skipped
 * without anyone deciding to skip it: an agent approves, nothing validates, the
 * validation ran on a different tier, or the proposal quietly edits whatever
 * was going to judge it.
 */

const pattern = {
  signature: 'spec omitted acceptance criteria',
  occurrences: 7,
  outcomes: ['failed', 'passed'],
  examples: ['t1', 't2', 't3'],
};

const proposal = (overrides: Partial<ImprovementProposal> = {}): ImprovementProposal => ({
  id: 'IMP-001',
  kind: 'prompt-template',
  target: 'spec',
  files: ['packages/agent-manager/src/skills/canonical.ts'],
  evidence: pattern,
  rationale: 'The spec skill omits acceptance criteria when the card has no linked decision.',
  ...overrides,
});

const validation = (overrides: Partial<ValidationRun> = {}): ValidationRun => ({
  suite: 'prompt-regression',
  passed: 24,
  failed: 0,
  tier: 'medium',
  at: '2026-08-14T00:00:00.000Z',
  ...overrides,
});

const human: Approval = { actorId: 'founder', actorKind: 'human', at: '2026-08-14T01:00:00.000Z' };
const agent: Approval = {
  actorId: 'reviewer-bot',
  actorKind: 'agent',
  at: '2026-08-14T01:00:00.000Z',
};

describe('the human step', () => {
  it('reaches approved only with a human approval', () => {
    const verdict = evaluateProposal(proposal(), validation(), 'medium', [human]);
    expect(verdict.state).toBe('approved');
  });

  it('stops at validated with no approval at all', () => {
    const verdict = evaluateProposal(proposal(), validation(), 'medium');
    expect(verdict.state).toBe('validated');
    expect(verdict.reasons.join(' ')).toContain('no automatic redeploy');
  });

  it('stops at validated when only an agent approved', () => {
    // A role can be assigned to a service account; `actorKind` cannot. The
    // human step exists specifically because automated gating does not catch
    // reward-hacking against a flawed evaluator.
    const verdict = evaluateProposal(proposal(), validation(), 'medium', [agent]);
    expect(verdict.state).toBe('validated');
    expect(verdict.reasons.join(' ')).toContain('none of them human');
  });

  it('has no state an automated actor can drive to the end', () => {
    // Stated as a property rather than as a comment: whatever an agent does,
    // the result is never `approved`.
    for (const approvals of [[], [agent], [agent, agent]]) {
      expect(evaluateProposal(proposal(), validation(), 'medium', approvals).state).not.toBe(
        'approved',
      );
    }
  });
});

describe('the protected surfaces', () => {
  it('rejects a proposal that would edit the evaluator', () => {
    // A loop permitted to improve its own evaluator optimises the evaluator.
    const verdict = evaluateProposal(
      proposal({ files: ['packages/agent-manager/src/trajectory-eval.ts'] }),
      validation(),
      'medium',
      [human],
    );
    expect(verdict.state).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('judges it');
  });

  it('rejects a proposal that would edit the approval boundary', () => {
    expect(
      evaluateProposal(
        proposal({ files: ['packages/core/src/insertion.ts'] }),
        validation(),
        'medium',
        [human],
      ).state,
    ).toBe('rejected');
  });

  it('rejects a proposal that would edit the mining logic itself', () => {
    expect(
      protectedFilesTouched(proposal({ files: ['packages/core/src/improvement.ts'] })),
    ).toHaveLength(1);
  });

  it('names the offending file, not just the rule', () => {
    // A finding that says a rule was broken without saying where is one nobody
    // can act on — and it looks identical to a correct finding.
    const verdict = evaluateProposal(
      proposal({ files: ['packages/core/src/insertion.ts'] }),
      validation(),
      'medium',
      [human],
    );
    expect(verdict.reasons.join(' ')).toContain('packages/core/src/insertion.ts');
  });

  it('rejects a protected-surface change before it is even validated', () => {
    // Ordering, asserted. If the protected check ran after validation, an
    // unvalidated proposal to edit the evaluator would report `proposed` — a
    // state that invites someone to go and validate it.
    const verdict = evaluateProposal(
      proposal({ files: ['packages/agent-manager/src/trajectory-eval.ts'] }),
      null,
      'medium',
    );
    expect(verdict.state).toBe('rejected');
  });

  it('rejects before anything else, even with a human approval and a green suite', () => {
    // The order matters. A protected-surface change that reached the human is a
    // change the human is being asked to wave through.
    const verdict = evaluateProposal(
      proposal({ files: ['packages/core/src/improvement.ts'] }),
      validation(),
      'medium',
      [human],
    );
    expect(verdict.state).toBe('rejected');
  });

  it('names every surface in one readable list', () => {
    // The boundary between a self-improving harness and RSI should be readable
    // in full by anyone who wonders where it is.
    expect(PROTECTED_SURFACES).toContain('trajectory-eval.ts');
    expect(PROTECTED_SURFACES).toContain('improvement.ts');
  });

  it('lets an ordinary skill change through', () => {
    expect(protectedFilesTouched(proposal())).toEqual([]);
  });
});

describe('held-out validation', () => {
  it('will not move past proposed without a run', () => {
    const verdict = evaluateProposal(proposal(), null, 'medium', [human]);
    expect(verdict.state).toBe('proposed');
    expect(verdict.reasons.join(' ')).toContain('mining signal alone never licenses');
  });

  it('rejects a run with failures', () => {
    expect(evaluateProposal(proposal(), validation({ failed: 2 }), 'medium', [human]).state).toBe(
      'rejected',
    );
  });

  it('rejects a suite that executed nothing', () => {
    // A suite that ran nothing is not a green suite — the same rule the evidence
    // gate applies to a zero-test verify run.
    const verdict = evaluateProposal(proposal(), validation({ passed: 0 }), 'medium', [human]);
    expect(verdict.state).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('executed 0 cases');
  });

  it('rejects a run on a tier production does not use', () => {
    // The STOP finding: improvement loops degrade performance on weaker models,
    // so nothing carries across a tier change.
    const verdict = evaluateProposal(proposal(), validation({ tier: 'high' }), 'medium', [human]);
    expect(verdict.state).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('degrade performance on weaker models');
  });
});

describe('the evidence behind a proposal', () => {
  it('rejects a pattern too rare to be one', () => {
    const thin = { ...pattern, occurrences: MIN_OCCURRENCES - 1 };
    const verdict = evaluateProposal(proposal({ evidence: thin }), validation(), 'medium', [human]);
    expect(verdict.state).toBe('rejected');
    expect(verdict.reasons.join(' ')).toContain('coincidence with a name');
  });
});

describe('mineTraces', () => {
  const trace = (id: string, signature: string, outcome: string): TraceRecord => ({
    id,
    skill: 'spec',
    signature,
    outcome,
  });

  it('reports a pattern seen often enough', () => {
    const result = mineTraces([
      trace('a', 'no acceptance criteria', 'failed'),
      trace('b', 'no acceptance criteria', 'failed'),
      trace('c', 'no acceptance criteria', 'passed'),
      trace('d', 'something else', 'passed'),
    ]);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.occurrences).toBe(3);
  });

  it('refuses a single-outcome sample rather than reporting from it', () => {
    // ADR-0026 names diversity collapse. Mining only what failed produces
    // "patterns" that are simply what the work looks like; mining only what
    // passed converges on safe fixes and never sees the rejected alternative.
    const result = mineTraces([
      trace('a', 'x', 'failed'),
      trace('b', 'x', 'failed'),
      trace('c', 'x', 'failed'),
    ]);
    expect(result.patterns).toEqual([]);
    expect(result.refusals.join(' ')).toContain('diversity collapse');
  });

  it('carries the outcomes a pattern was drawn from', () => {
    const result = mineTraces([
      trace('a', 'x', 'failed'),
      trace('b', 'x', 'passed'),
      trace('c', 'x', 'rejected'),
    ]);
    expect(result.patterns[0]?.outcomes).toEqual(['failed', 'passed', 'rejected']);
  });

  it('drops a signature below the occurrence floor', () => {
    const result = mineTraces([trace('a', 'x', 'failed'), trace('b', 'x', 'passed')]);
    expect(result.patterns).toEqual([]);
  });

  it('says nothing about an empty sample rather than refusing it', () => {
    // No traces is not a diversity problem; it is no traces.
    expect(mineTraces([])).toEqual({ patterns: [], refusals: [] });
  });

  it('orders by how often a pattern recurs', () => {
    const result = mineTraces([
      ...['a', 'b', 'c'].map((id) => trace(id, 'rare', 'failed')),
      ...['d', 'e', 'f', 'g'].map((id) => trace(id, 'common', 'passed')),
    ]);
    expect(result.patterns.map((entry) => entry.signature)).toEqual(['common', 'rare']);
  });
});

describe('formatProposalVerdict', () => {
  it('shows the reason, not only the state', () => {
    const text = formatProposalVerdict(evaluateProposal(proposal(), validation(), 'medium'));
    expect(text).toContain('IMP-001: validated');
    expect(text).toContain('waiting for a human');
  });
});

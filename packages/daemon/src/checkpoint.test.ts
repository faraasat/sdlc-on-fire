import { describe, expect, it } from 'vitest';
import { decideResume, stepIdentity, type Checkpoint } from './checkpoint.js';

/**
 * P1-AGENT-05 — resume (ADR-0022/0039).
 *
 * The interesting tests are the ones where the log and the world disagree. A
 * checkpoint is written by the process that then crashed, so it is a claim; the
 * whole point of the reconciler is that this product does not resume on claims
 * any more than it gates on them.
 */

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const step = (over: Partial<Checkpoint> & { stepSeq: number }): Checkpoint => ({
  runId: 'run-1',
  stepIdentity: stepIdentity({ runId: 'run-1', stepSeq: over.stepSeq, stepType: 'x' }),
  stepType: 'implement',
  mutatesState: true,
  contentHash: 'c'.repeat(64),
  status: 'complete',
  createdAt: '2026-08-10T00:00:00.000Z',
  ...over,
});

describe('stepIdentity', () => {
  it('is stable across attempts', () => {
    const a = stepIdentity({ runId: 'run-1', stepSeq: 3, stepType: 'commit' });
    const b = stepIdentity({ runId: 'run-1', stepSeq: 3, stepType: 'commit' });
    // A retry has to land on the same row, or the sequence a resume walks has
    // the same step in it twice.
    expect(a).toBe(b);
  });

  it('distinguishes steps within a run', () => {
    expect(stepIdentity({ runId: 'run-1', stepSeq: 3, stepType: 'commit' })).not.toBe(
      stepIdentity({ runId: 'run-1', stepSeq: 4, stepType: 'commit' }),
    );
  });
});

describe('decideResume', () => {
  it('starts fresh when nothing was recorded', () => {
    expect(decideResume([], { worktreePresent: true }).action).toBe('start-fresh');
  });

  it('escalates a missing worktree before anything else', () => {
    const decision = decideResume([step({ stepSeq: 1, gitSha: HEAD })], {
      worktreePresent: false,
      headSha: HEAD,
    });
    // Every other branch reasons about a tree that would not be there.
    expect(decision.action).toBe('needs-human');
  });

  it('escalates rather than resuming past a failed step', () => {
    const decision = decideResume(
      [step({ stepSeq: 1, gitSha: HEAD }), step({ stepSeq: 2, status: 'failed' })],
      { worktreePresent: true, headSha: HEAD },
    );
    expect(decision.action).toBe('needs-human');
    if (decision.action !== 'needs-human') return;
    expect(decision.reason).toContain('would build on it');
  });

  it('starts fresh when nothing recorded actually changed anything', () => {
    const decision = decideResume(
      [step({ stepSeq: 1, mutatesState: false }), step({ stepSeq: 2, mutatesState: false })],
      { worktreePresent: true, headSha: HEAD },
    );
    // Resuming from a step that changed nothing restores a model to the middle
    // of its own reasoning — the self-conditioning failure ADR-0039 names.
    expect(decision.action).toBe('start-fresh');
  });

  it('continues after the last step when the log matches reality', () => {
    const decision = decideResume([step({ stepSeq: 1, gitSha: HEAD })], {
      worktreePresent: true,
      headSha: HEAD,
    });
    expect(decision).toMatchObject({ action: 'resume', fromSeq: 2 });
  });

  it('re-runs an interrupted step rather than skipping it', () => {
    const decision = decideResume(
      [step({ stepSeq: 1, gitSha: HEAD }), step({ stepSeq: 2, status: 'in_progress' })],
      { worktreePresent: true, headSha: HEAD },
    );
    // Side effects are guarded by the idempotency key, so re-running is safe
    // and skipping is not.
    expect(decision).toMatchObject({ action: 'resume', fromSeq: 2 });
  });

  it('re-runs a step whose claimed commit is not in the worktree', () => {
    const decision = decideResume(
      [step({ stepSeq: 1, gitSha: HEAD }), step({ stepSeq: 2, gitSha: OTHER })],
      // The world says HEAD; step 2 claims OTHER. Its commit never landed.
      { worktreePresent: true, headSha: HEAD },
    );
    expect(decision).toMatchObject({ action: 'resume', fromSeq: 2 });
    if (decision.action !== 'resume') return;
    expect(decision.reason).toContain('not in the worktree');
  });

  it('escalates when no recorded step matches what is actually there', () => {
    const decision = decideResume([step({ stepSeq: 1, gitSha: OTHER })], {
      worktreePresent: true,
      headSha: HEAD,
    });
    // Something moved the tree that this run did not do. Guessing which step to
    // resume from would build on a state nothing recorded.
    expect(decision.action).toBe('needs-human');
  });

  it('reads the sequence by step number, not by insertion order', () => {
    const decision = decideResume(
      [step({ stepSeq: 3, gitSha: HEAD }), step({ stepSeq: 1, gitSha: HEAD })],
      { worktreePresent: true, headSha: HEAD },
    );
    expect(decision).toMatchObject({ action: 'resume', fromSeq: 4 });
  });
});

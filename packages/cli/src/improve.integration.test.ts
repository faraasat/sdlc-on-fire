import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approveImprovement, mineImprovements, reviewImprovements } from './improve.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `sdlc improve` against a real workspace (P2-SKILL-04).
 *
 * The unit tests establish that `evaluateProposal` refuses. What these establish
 * is that the *command* refuses — that there is no path through the CLI that
 * reaches `approved` without a person, and that the protected-surface rule
 * survives someone approving anyway.
 */

const dirs: string[] = [];

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-improve-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return root;
}

const stored = (id: string, overrides: { files?: string[]; validation?: unknown } = {}): string =>
  JSON.stringify({
    proposal: {
      id,
      kind: 'prompt-template',
      target: 'spec',
      files: overrides.files ?? ['packages/agent-manager/src/skills/canonical.ts'],
      evidence: {
        signature: 'acceptance criteria omitted',
        occurrences: 7,
        outcomes: ['failed', 'passed'],
        examples: ['t1'],
      },
      rationale: 'the spec skill omits acceptance criteria when no decision is linked',
    },
    validation:
      'validation' in overrides
        ? overrides.validation
        : {
            suite: 'prompt-regression',
            passed: 24,
            failed: 0,
            tier: 'medium',
            at: '2026-08-14T00:00:00.000Z',
          },
  });

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('mineImprovements', () => {
  it('reads a JSONL trace log — the shape a run log actually accumulates in', async () => {
    const root = await workspace({
      'traces.jsonl': [
        '{"id":"t1","skill":"spec","signature":"a","outcome":"failed"}',
        '{"id":"t2","skill":"spec","signature":"a","outcome":"failed"}',
        '{"id":"t3","skill":"spec","signature":"a","outcome":"passed"}',
        '',
      ].join('\n'),
    });

    const result = await mineImprovements(root, 'traces.jsonl');
    expect(result.tracesRead).toBe(3);
    expect(result.result.patterns[0]?.occurrences).toBe(3);
  });

  it('says so rather than reporting nothing when the file is not there', async () => {
    const root = await workspace();
    await expect(mineImprovements(root, 'nope.jsonl')).rejects.toThrow(/no trace file/);
  });
});

describe('the loop, end to end', () => {
  it('leaves a validated proposal waiting, with nothing that advances it', async () => {
    const root = await workspace({ 'kanban/_improvements/IMP-001.json': stored('IMP-001') });

    const review = await reviewImprovements(root, 'medium');
    expect(review.verdicts[0]?.state).toBe('validated');
    expect(review.settled).toBe(false);
  });

  it('reaches approved only through the approve command', async () => {
    const root = await workspace({ 'kanban/_improvements/IMP-001.json': stored('IMP-001') });

    const result = await approveImprovement(
      root,
      'IMP-001',
      'founder',
      'medium',
      () => '2026-08-14T01:00:00.000Z',
    );
    expect(result.verdict.state).toBe('approved');

    // And it stays approved on a fresh read: the approval was written, not
    // held in memory for the length of one command.
    expect((await reviewImprovements(root, 'medium')).verdicts[0]?.state).toBe('approved');
  });

  it('refuses a protected-surface change even when a person approves it', async () => {
    // The order matters. A proposal that edits the evaluator and reaches a human
    // is one the human is being asked to wave through.
    const root = await workspace({
      'kanban/_improvements/IMP-002.json': stored('IMP-002', {
        files: ['packages/agent-manager/src/trajectory-eval.ts'],
      }),
    });

    const result = await approveImprovement(root, 'IMP-002', 'founder', 'medium');
    expect(result.verdict.state).toBe('rejected');
  });

  it('records an approval that did not carry', async () => {
    // A refused approval is a fact about the review. Dropping it would let the
    // same proposal be approved twice with nothing showing the first attempt
    // was refused for a reason nobody fixed.
    const root = await workspace({
      'kanban/_improvements/IMP-003.json': stored('IMP-003', { validation: undefined }),
    });

    const result = await approveImprovement(root, 'IMP-003', 'founder', 'medium');
    expect(result.verdict.state).toBe('proposed');

    const written = JSON.parse(
      await fs.readFile(path.join(root, 'kanban/_improvements/IMP-003.json'), 'utf8'),
    ) as { approvals: { actorId: string }[] };
    expect(written.approvals[0]?.actorId).toBe('founder');
  });

  it('refuses a proposal validated on a tier production does not run', async () => {
    const root = await workspace({ 'kanban/_improvements/IMP-004.json': stored('IMP-004') });
    const result = await approveImprovement(root, 'IMP-004', 'founder', 'high');
    expect(result.verdict.state).toBe('rejected');
    expect(result.verdict.reasons.join(' ')).toContain('degrade performance on weaker models');
  });

  it('names a missing proposal rather than silently approving nothing', async () => {
    const root = await workspace();
    await expect(approveImprovement(root, 'IMP-404', 'founder', 'medium')).rejects.toThrow(
      /no improvement proposal with id/,
    );
  });

  it('skips a malformed file rather than hiding every proposal behind it', async () => {
    const root = await workspace({
      'kanban/_improvements/broken.json': '{ not json',
      'kanban/_improvements/IMP-005.json': stored('IMP-005'),
    });
    expect((await reviewImprovements(root, 'medium')).verdicts).toHaveLength(1);
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dispatchIsolated,
  runsIsolated,
  summaryBudgetFor,
  DEFAULT_SUMMARY_BUDGET_CHARS,
} from './isolation.js';
import { SPEC_SKILL, IMPLEMENT_SKILL } from './skills/canonical.js';
import { REVIEW_SKILL } from './skills/review.js';
import type { AgentTransport } from './dispatch.js';

/**
 * Fresh-context subagent dispatch (P1-CTX-05).
 *
 * The property under test is a cost property: a subagent's whole value is that
 * it reads and writes in its own context window, and pasting its full output
 * back into the parent destroys that.
 */

let dir: string;

/**
 * A spec output that satisfies the skill's contract, plus whatever this test
 * wants to say. Payloads here used to be arbitrary objects; the output contract
 * is now applied at the dispatch boundary, so a fixture that would be refused in
 * production is no longer a useful stand-in for one that would not.
 */
const specOutput = (extra: Record<string, unknown>): Record<string, unknown> => ({
  work_item_id: 'FEAT-001',
  summary: 'CSV export',
  acceptance_criteria: ['GIVEN a table WHEN exported THEN a .csv is written'],
  non_goals: ['multi-currency'],
  handoff: { openQuestions: [] },
  ...extra,
});

const transportReturning =
  (output: Record<string, unknown>): AgentTransport =>
  () =>
    Promise.resolve({
      stdout: `spec_output ${JSON.stringify(specOutput(output))}`,
      stderr: '',
      exitCode: 0,
    });

const request = {
  skill: SPEC_SKILL,
  variables: { work_item_id: 'FEAT-001', work_item_title: 'CSV export' },
  cwd: process.cwd(),
};

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolation-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('what comes back to the parent', () => {
  it('returns the whole output when it is small', async () => {
    const result = await dispatchIsolated(request, transportReturning({}), {
      artifactDir: dir,
      runId: 'small',
    });
    expect(result.truncated).toBe(false);
    expect(result.summary).toContain('CSV export');
  });

  it('bounds a large output so the parent context does not absorb it', async () => {
    const big = { open_questions: ['x'.repeat(50_000)] };
    const result = await dispatchIsolated(request, transportReturning(big), {
      artifactDir: dir,
      runId: 'big',
    });

    expect(result.truncated).toBe(true);
    expect(result.summary.length).toBeLessThan(result.fullLength);
    expect(result.summary.length).toBeLessThanOrEqual(summaryBudgetFor('spec') + 200);
  });

  it('says plainly that it was cut', async () => {
    // A summary that looks complete but isn't is worse than an obviously
    // partial one — the reader stops looking for what is missing.
    const result = await dispatchIsolated(
      request,
      transportReturning({ open_questions: ['y'.repeat(50_000)] }),
      { artifactDir: dir, runId: 'cut' },
    );
    expect(result.summary).toMatch(/truncated/);
    expect(result.summary).toMatch(/full output on disk/);
  });
});

describe('the pointer', () => {
  it('writes the complete output before anything is truncated', async () => {
    // A summary is not a place to lose data; a caller that wants the detail
    // must always be able to get it.
    const big = { open_questions: ['z'.repeat(50_000)] };
    const result = await dispatchIsolated(request, transportReturning(big), {
      artifactDir: dir,
      runId: 'pointer',
    });

    const onDisk = JSON.parse(await fs.readFile(result.outputPath, 'utf8')) as typeof big;
    expect(onDisk.open_questions[0]).toHaveLength(50_000);
    expect(result.fullLength).toBeGreaterThan(50_000);
  });

  it('creates the artifact directory rather than failing on a fresh workspace', async () => {
    const fresh = path.join(dir, 'nested', 'run-1');
    const result = await dispatchIsolated(request, transportReturning({}), {
      artifactDir: fresh,
      runId: 'nested',
    });
    await expect(fs.stat(result.outputPath)).resolves.toBeDefined();
  });
});

describe('per-stage budgets', () => {
  it('gives a retrospective a far tighter budget than a review', () => {
    // A retrospective that returns as much as a review has misunderstood its job.
    expect(summaryBudgetFor('retrospective')).toBeLessThan(summaryBudgetFor('review'));
  });

  it('falls back to a default for an unknown stage', () => {
    expect(summaryBudgetFor('a-stage-nobody-declared')).toBe(DEFAULT_SUMMARY_BUDGET_CHARS);
  });

  it('honours an explicit override', async () => {
    const result = await dispatchIsolated(
      request,
      transportReturning({ open_questions: ['q'.repeat(10_000)] }),
      { artifactDir: dir, runId: 'override', summaryBudgetChars: 200 },
    );
    expect(result.summary.length).toBeLessThan(500);
  });
});

describe('which skills run isolated', () => {
  it('follows the skill own declared context mode', () => {
    // review and retrospective fork; spec and implement run inline.
    expect(runsIsolated(REVIEW_SKILL)).toBe(true);
    expect(runsIsolated(SPEC_SKILL)).toBe(false);
    expect(runsIsolated(IMPLEMENT_SKILL)).toBe(false);
  });
});

describe('the stage boundary (P1-CTX-07)', () => {
  const boundary = (extra: Record<string, unknown> = {}) => ({
    runId: 'run-b',
    workItemId: 'FEAT-001',
    from: 'spec' as const,
    to: 'plan' as const,
    stateDir: dir,
    ...extra,
  });

  it('does not look for a handoff when no boundary was declared', async () => {
    const result = await dispatchIsolated(request, transportReturning({}), {
      artifactDir: dir,
      runId: 'no-boundary',
    });
    expect(result.handoff).toBeNull();
    expect(result.handoffRejection).toBeUndefined();
  });

  it('validates, stamps and persists the handoff at a boundary', async () => {
    const result = await dispatchIsolated(
      request,
      transportReturning({
        handoff: {
          openQuestions: ['does the importer need CSV?'],
          decisions: [{ statement: 'ship JSON first', because: 'both pilots export JSON' }],
          requiredInputs: ['the schema file'],
        },
      }),
      { artifactDir: dir, runId: 'boundary', boundary: boundary() },
    );

    expect(result.handoff?.from).toBe('spec');
    expect(result.handoff?.to).toBe('plan');
    // Identity comes from the orchestrator, which knows where it dispatched to.
    expect(result.handoff?.runId).toBe('run-b');
    expect(result.handoff?.openQuestions).toEqual(['does the importer need CSV?']);

    const onDisk = JSON.parse(await fs.readFile(result.handoffPath ?? '', 'utf8')) as {
      requiredInputs: string[];
    };
    expect(onDisk.requiredInputs).toEqual(['the schema file']);
  });

  it('reports a dropped open question instead of accepting the boundary', async () => {
    const previous = {
      schema_version: '1' as const,
      runId: 'run-b',
      workItemId: 'FEAT-001',
      from: 'intake' as const,
      to: 'spec' as const,
      decisions: [],
      openQuestions: ['who owns the retry budget?'],
      artifacts: [],
      requiredInputs: [],
      notes: '',
    };

    const result = await dispatchIsolated(
      request,
      transportReturning({ handoff: { openQuestions: [] } }),
      { artifactDir: dir, runId: 'dropped', boundary: boundary({ previous }) },
    );

    // The stage ran and produced valid output; what it handed forward is not
    // consumable, and that has to be visible rather than absorbed.
    expect(result.handoff).toBeNull();
    expect(result.handoffRejection?.reason).toBe('structural');
    expect(result.handoffRejection?.detail).toContain('retry budget');
    expect(result.summary).toContain('CSV export');
  });
});

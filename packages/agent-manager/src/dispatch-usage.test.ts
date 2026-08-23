import { describe, expect, it } from 'vitest';
import { CANONICAL_SKILLS } from './skills/canonical.js';
import { dispatchSkill, usageFromEnvelope, type AgentTransport } from './dispatch.js';
import type { RunFinish, RunRecorder, RunStart } from '@sdlc-on-fire/core';

const SKILL = CANONICAL_SKILLS['retrospective'];

function collector(): { recorder: RunRecorder; starts: RunStart[]; finishes: RunFinish[] } {
  const starts: RunStart[] = [];
  const finishes: RunFinish[] = [];
  return {
    starts,
    finishes,
    recorder: {
      start(run) {
        starts.push(run);
        return Promise.resolve();
      },
      finish(run) {
        finishes.push(run);
        return Promise.resolve();
      },
    },
  };
}

const VALID = `retrospective_output ${JSON.stringify({
  work_item_id: 'FEAT-001',
  memory_entries: [],
  summary: 'nothing durable — routine work',
})}`;

const transport =
  (result: Partial<Awaited<ReturnType<AgentTransport>>>): AgentTransport =>
  () =>
    Promise.resolve({ stdout: VALID, stderr: '', exitCode: 0, ...result });

describe('usageFromEnvelope (P6-INSTRUMENT-02)', () => {
  it('reads what the CLI charged rather than computing it', () => {
    // A per-model price table times token counts is the obvious alternative and
    // it is quietly false from the first price change onward.
    expect(
      usageFromEnvelope({
        total_cost_usd: 0.0123,
        usage: { input_tokens: 900, output_tokens: 40 },
      }),
    ).toEqual({ inputTokens: 900, outputTokens: 40, costUsd: 0.0123 });
  });

  it('returns nothing at all when the envelope reports nothing', () => {
    // Not `{}`. An empty usage object records "usage was reported and it was
    // nothing", which is the confusion the nullable columns exist to avoid.
    expect(usageFromEnvelope({ result: 'hi' })).toBeUndefined();
    expect(usageFromEnvelope('not an object')).toBeUndefined();
  });

  it('ignores fields that are not finite numbers', () => {
    // A CLI change that turns a number into a string must not record NaN as a
    // cost, and `Number(null)` is 0 — the exact value that means "free".
    expect(usageFromEnvelope({ total_cost_usd: 'lots', usage: { input_tokens: 5 } })).toEqual({
      inputTokens: 5,
    });
  });
});

describe('dispatch records what a run cost and why it failed', () => {
  it('carries usage onto the finished row', async () => {
    const { recorder, finishes } = collector();
    await dispatchSkill(
      {
        skill: SKILL!,
        variables: { work_item_id: 'FEAT-001' },
        cwd: process.cwd(),
        recorder,
        runId: 'run-1',
        workItemId: 'FEAT-001',
      },
      transport({ usage: { costUsd: 0.02, inputTokens: 10, outputTokens: 2 } }),
    );
    expect(finishes[0]?.status).toBe('pass');
    expect(finishes[0]?.usage?.costUsd).toBe(0.02);
    // A run that passed has no failure reason. One there would be counted as a
    // failure by every query that reads the column looking for one.
    expect(finishes[0]?.failureReason).toBeUndefined();
  });

  it('records a broken output contract as a failure, not a pass', async () => {
    // Found while building this: `extractToolOutput` used to run *after* the row
    // was settled as a pass, so a model that could not produce its own contract
    // was recorded as having succeeded — and the tokens it spent were recorded
    // against a run that looked fine.
    const { recorder, finishes } = collector();
    await expect(
      dispatchSkill(
        {
          skill: SKILL!,
          variables: { work_item_id: 'FEAT-001' },
          cwd: process.cwd(),
          recorder,
          runId: 'run-2',
          workItemId: 'FEAT-001',
        },
        transport({
          stdout: 'I had a think about it and it seems fine.',
          usage: { costUsd: 0.09 },
        }),
      ),
    ).rejects.toThrow();
    expect(finishes[0]?.status).toBe('fail');
    expect(finishes[0]?.failureReason).toBe('output-contract');
    // The tokens were spent either way. A failed run reporting no cost is how an
    // agent-loop budget goes missing.
    expect(finishes[0]?.usage?.costUsd).toBe(0.09);
  });

  it('distinguishes an agent that certified its own work', async () => {
    const { recorder, finishes } = collector();
    await expect(
      dispatchSkill(
        {
          skill: SKILL!,
          variables: { work_item_id: 'FEAT-001' },
          cwd: process.cwd(),
          recorder,
          runId: 'run-3',
          workItemId: 'FEAT-001',
        },
        transport({
          stdout: `retrospective_output ${JSON.stringify({ work_item_id: 'X', testsPassed: true })}`,
        }),
      ),
    ).rejects.toThrow();
    expect(finishes[0]?.failureReason).toBe('forbidden-claim');
  });

  it('calls a killed child a timeout, not a generic transport failure', async () => {
    // A timeout reaches this path as a non-zero exit, so the fallback answer
    // would be `transport` — true but useless. The DispatchError carries the
    // target's own last words, and "SIGTERM" in them is the difference between
    // "raise the limit" and "something is broken". Passing the cause to the
    // recorder rather than letting it fall back is what preserves that.
    const { recorder, finishes } = collector();
    await expect(
      dispatchSkill(
        {
          skill: SKILL!,
          variables: { work_item_id: 'FEAT-001' },
          cwd: process.cwd(),
          recorder,
          runId: 'run-5',
          workItemId: 'FEAT-001',
        },
        transport({ exitCode: 1, stderr: 'claude was killed by SIGTERM after 600s' }),
      ),
    ).rejects.toThrow();
    expect(finishes[0]?.failureReason).toBe('timeout');
  });

  it('records a non-zero exit as a transport failure', async () => {
    const { recorder, finishes } = collector();
    await expect(
      dispatchSkill(
        {
          skill: SKILL!,
          variables: { work_item_id: 'FEAT-001' },
          cwd: process.cwd(),
          recorder,
          runId: 'run-4',
          workItemId: 'FEAT-001',
        },
        transport({ exitCode: 1, stderr: 'Not logged in' }),
      ),
    ).rejects.toThrow();
    expect(finishes[0]?.status).toBe('fail');
    expect(finishes[0]?.failureReason).toBe('transport');
  });
});

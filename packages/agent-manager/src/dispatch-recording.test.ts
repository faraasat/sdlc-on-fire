import { describe, expect, it, vi } from 'vitest';
import { dispatchSkill, DispatchError, type AgentTransport } from './dispatch.js';
import { CANONICAL_SKILLS } from './skills/canonical.js';
import type { RunFinish, RunRecorder, RunStart } from '@sdlc-on-fire/core';

function spyRecorder() {
  const starts: RunStart[] = [];
  const finishes: RunFinish[] = [];
  const order: string[] = [];
  const recorder: RunRecorder = {
    start: (r) => {
      starts.push(r);
      order.push('start');
      return Promise.resolve();
    },
    finish: (r) => {
      finishes.push(r);
      order.push('finish');
      return Promise.resolve();
    },
  };
  return { recorder, starts, finishes, order };
}

const skill = CANONICAL_SKILLS['implement']!;

const base = (recorder: RunRecorder) => ({
  skill,
  variables: { work_item_id: 'TASK-1' },
  cwd: '/tmp',
  recorder,
  runId: 'run-1',
  workItemId: 'TASK-1',
});

const GOOD =
  'implement_output {"work_item_id":"TASK-1","summary":"did the thing",' +
  '"files_changed":["a.ts"],"handoff":{"openQuestions":[]}}';

const ok = (): AgentTransport =>
  vi.fn(() => Promise.resolve({ stdout: GOOD, stderr: '', exitCode: 0 }));

describe('dispatch records the run', () => {
  it('writes the row before the transport is called, not after', async () => {
    const { recorder, order } = spyRecorder();
    const seen: string[] = [];
    const transport: AgentTransport = () => {
      seen.push(...order); // what had been recorded by the time work began
      return Promise.resolve({ stdout: GOOD, stderr: '', exitCode: 0 });
    };
    await dispatchSkill(base(recorder), transport).catch(() => undefined);
    // A row created on completion never exists for a dispatch that hung or was
    // killed — and those are the runs somebody actually goes looking for.
    expect(seen).toEqual(['start']);
  });

  it('finishes as pass on a clean run', async () => {
    const { recorder, finishes } = spyRecorder();
    await dispatchSkill(base(recorder), ok());
    expect(finishes).toHaveLength(1);
    expect(finishes[0]?.status).toBe('pass');
  });

  it('finishes as fail when the target exits non-zero', async () => {
    const { recorder, finishes } = spyRecorder();
    const transport: AgentTransport = () =>
      Promise.resolve({ stdout: '', stderr: 'boom', exitCode: 3 });
    await expect(dispatchSkill(base(recorder), transport)).rejects.toThrow(DispatchError);
    expect(finishes[0]?.status).toBe('fail');
  });

  it('finishes as error when the transport itself throws', async () => {
    // A run whose work failed and a run that could not execute are different
    // problems with different fixes; collapsing them makes a broken transport
    // look like a low-quality agent.
    const { recorder, finishes } = spyRecorder();
    const transport: AgentTransport = () => Promise.reject(new Error('spawn ENOENT'));
    await expect(dispatchSkill(base(recorder), transport)).rejects.toThrow('spawn ENOENT');
    expect(finishes[0]?.status).toBe('error');
  });

  it('never leaves a failed run stuck in "running"', async () => {
    const { recorder, starts, finishes } = spyRecorder();
    const transport: AgentTransport = () => Promise.reject(new Error('nope'));
    await dispatchSkill(base(recorder), transport).catch(() => undefined);
    expect(starts).toHaveLength(1);
    expect(finishes).toHaveLength(1);
  });

  it('records the identifying fields, not just the timing', async () => {
    const { recorder, starts } = spyRecorder();
    await dispatchSkill(
      {
        ...base(recorder),
        model: 'claude-opus-5',
        contextPackPath: '.sdlc/context/packs/run-1.md',
      },
      ok(),
    );
    expect(starts[0]).toMatchObject({
      id: 'run-1',
      workItemId: 'TASK-1',
      skillId: 'implement',
      agentTarget: 'claude-code',
      model: 'claude-opus-5',
      contextPackPath: '.sdlc/context/packs/run-1.md',
    });
  });

  it('timestamps are ISO instants and finish never precedes start', async () => {
    const { recorder, starts, finishes } = spyRecorder();
    await dispatchSkill(base(recorder), ok());
    const started = Date.parse(starts[0]!.startedAt);
    const finished = Date.parse(finishes[0]!.finishedAt);
    expect(Number.isNaN(started)).toBe(false);
    expect(Number.isNaN(finished)).toBe(false);
    expect(finished).toBeGreaterThanOrEqual(started);
  });

  it('dispatches unchanged when no recorder is supplied', async () => {
    const result = await dispatchSkill(
      { skill, variables: { work_item_id: 'TASK-1' }, cwd: '/tmp' },
      ok(),
    );
    expect(result.skill).toBe('implement');
  });

  it('does not record when a runId is missing, rather than inventing one', async () => {
    // An id minted inside dispatch would differ on every retry of the write and
    // produce duplicate rows for one run.
    const { recorder, starts } = spyRecorder();
    await dispatchSkill(
      { skill, variables: { work_item_id: 'TASK-1' }, cwd: '/tmp', recorder, workItemId: 'TASK-1' },
      ok(),
    );
    expect(starts).toHaveLength(0);
  });
});

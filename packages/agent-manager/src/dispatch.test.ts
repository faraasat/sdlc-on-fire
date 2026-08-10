import { describe, expect, it } from 'vitest';
import {
  dispatchSkill,
  DispatchError,
  extractToolOutput,
  FORBIDDEN_OUTPUT_FIELDS,
  OutputContractError,
  type AgentTransport,
} from './dispatch.js';
import { IMPLEMENT_SKILL } from './skills/canonical.js';

const variables = { work_item_id: 'FEAT-001', work_item_title: 'Add CSV export' };

function transport(stdout: string, exitCode = 0): AgentTransport {
  return () => Promise.resolve({ stdout, stderr: '', exitCode });
}

const goodOutput = `implement_output {"work_item_id":"TASK-001","summary":"Added export.","files_changed":["src/csv.ts"]}`;

describe('output extraction', () => {
  it('pulls the payload after the declared tool name', () => {
    expect(extractToolOutput(goodOutput, IMPLEMENT_SKILL)).toEqual({
      work_item_id: 'TASK-001',
      files_changed: ['src/csv.ts'],
      summary: 'Added export.',
    });
  });

  it('tolerates surrounding chatter', () => {
    const noisy = `thinking...\n${goodOutput}\ndone`;
    expect(extractToolOutput(noisy, IMPLEMENT_SKILL)).toMatchObject({ summary: 'Added export.' });
  });

  it('refuses prose instead of guessing what it meant', () => {
    expect(() => extractToolOutput('I finished the work!', IMPLEMENT_SKILL)).toThrow(
      OutputContractError,
    );
  });

  it('refuses malformed JSON', () => {
    expect(() => extractToolOutput('implement_output {broken', IMPLEMENT_SKILL)).toThrow(
      OutputContractError,
    );
  });

  it('refuses a non-object payload', () => {
    expect(() =>
      extractToolOutput(
        `implement_output {"work_item_id":"TASK-001","summary":"Added export.","files_changed":["src/csv.ts"]}[1,2]`,
        IMPLEMENT_SKILL,
      ),
    ).not.toThrow();
    expect(() => extractToolOutput('implement_output []', IMPLEMENT_SKILL)).toThrow(
      OutputContractError,
    );
  });
});

describe('the agent cannot self-report verification', () => {
  it.each(FORBIDDEN_OUTPUT_FIELDS)('rejects an output claiming %s', (field) => {
    // The whole product in one assertion: the daemon runs verify, not the agent.
    const payload = `implement_output {"work_item_id":"TASK-001","summary":"done","files_changed":["a.ts"],"${field}":true}`;
    expect(() => extractToolOutput(payload, IMPLEMENT_SKILL)).toThrow(OutputContractError);
  });

  it('names the offending field so the skill author can fix it', () => {
    try {
      extractToolOutput(
        'implement_output {"work_item_id":"TASK-001","summary":"d","files_changed":["a.ts"],"verified":true}',
        IMPLEMENT_SKILL,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as OutputContractError).message).toContain('verified');
      expect((error as OutputContractError).message).toContain('the daemon runs verify');
    }
  });

  it('accepts an honest report of what was changed', () => {
    expect(extractToolOutput(goodOutput, IMPLEMENT_SKILL)).toHaveProperty('files_changed');
  });
});

describe('dispatch', () => {
  it('returns a structured result', async () => {
    const result = await dispatchSkill(
      { skill: IMPLEMENT_SKILL, variables, cwd: '/tmp' },
      transport(goodOutput),
    );

    expect(result.skill).toBe('implement');
    expect(result.target).toBe('claude-code');
    expect(result.output).toMatchObject({ summary: 'Added export.' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retains raw output so a human can see what happened', async () => {
    const result = await dispatchSkill(
      { skill: IMPLEMENT_SKILL, variables, cwd: '/tmp' },
      transport(goodOutput),
    );
    expect(result.raw).toContain('implement_output');
  });

  it('fills the task template before sending it', async () => {
    let seen = '';
    const spy: AgentTransport = ({ prompt }) => {
      seen = prompt;
      return Promise.resolve({ stdout: goodOutput, stderr: '', exitCode: 0 });
    };

    await dispatchSkill({ skill: IMPLEMENT_SKILL, variables, cwd: '/tmp' }, spy);
    expect(seen).toContain('FEAT-001');
    expect(seen).not.toContain('{{');
  });

  it('refuses to dispatch with an unfilled slot', async () => {
    await expect(
      dispatchSkill({ skill: IMPLEMENT_SKILL, variables: {}, cwd: '/tmp' }, transport(goodOutput)),
    ).rejects.toThrow(/unresolved slots/);
  });

  it('reports a non-zero exit rather than parsing garbage', async () => {
    await expect(
      dispatchSkill({ skill: IMPLEMENT_SKILL, variables, cwd: '/tmp' }, transport('', 1)),
    ).rejects.toBeInstanceOf(DispatchError);
  });
});

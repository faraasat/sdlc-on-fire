import { describe, expect, it } from 'vitest';
import {
  dispatchSkill,
  DispatchError,
  extractToolOutput,
  FORBIDDEN_OUTPUT_FIELDS,
  OutputContractError,
  windowsSpawn,
  type AgentTransport,
} from './dispatch.js';
import { IMPLEMENT_SKILL } from './skills/canonical.js';

const variables = { work_item_id: 'FEAT-001', work_item_title: 'Add CSV export' };

function transport(stdout: string, exitCode = 0): AgentTransport {
  return () => Promise.resolve({ stdout, stderr: '', exitCode });
}

const goodOutput = `implement_output {"work_item_id":"TASK-001","summary":"Added export.","files_changed":["src/csv.ts"],"handoff":{"openQuestions":[]}}`;

describe('output extraction', () => {
  it('pulls the payload after the declared tool name', () => {
    expect(extractToolOutput(goodOutput, IMPLEMENT_SKILL)).toEqual({
      work_item_id: 'TASK-001',
      files_changed: ['src/csv.ts'],
      summary: 'Added export.',
      handoff: { openQuestions: [] },
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
        `implement_output {"work_item_id":"TASK-001","summary":"Added export.","files_changed":["src/csv.ts"],"handoff":{"openQuestions":[]}}[1,2]`,
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
    const payload = `implement_output {"work_item_id":"TASK-001","summary":"done","files_changed":["a.ts"],"handoff":{"openQuestions":[]},"${field}":true}`;
    expect(() => extractToolOutput(payload, IMPLEMENT_SKILL)).toThrow(OutputContractError);
  });

  it('names the offending field so the skill author can fix it', () => {
    try {
      extractToolOutput(
        'implement_output {"work_item_id":"TASK-001","summary":"d","files_changed":["a.ts"],"handoff":{"openQuestions":[]},"verified":true}',
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

describe('recursion depth at the spawn point (P1-AGENT-07)', () => {
  const transport = (): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    Promise.resolve({
      stdout: goodOutput,
      stderr: '',
      exitCode: 0,
    });

  const request = {
    skill: IMPLEMENT_SKILL,
    variables: { work_item_id: 'TASK-001', work_item_title: 'x' },
    cwd: process.cwd(),
  };

  it('allows a spawn at or under the limit', async () => {
    await expect(dispatchSkill({ ...request, depth: 2 }, transport)).resolves.toBeDefined();
  });

  it('refuses a spawn beyond it', async () => {
    // The cap lived only in the wave planner, which had no caller anywhere in
    // the product — so a subagent spawning a subagent was bounded by nothing.
    await expect(dispatchSkill({ ...request, depth: 3 }, transport)).rejects.toThrow(
      /beyond the limit of 2/,
    );
  });

  it('refuses before spending anything', async () => {
    // The cheapest refusal is the one that happens before a token is spent, so
    // the transport must never be reached.
    let called = false;
    const spy = (): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      called = true;
      return transport();
    };
    await expect(dispatchSkill({ ...request, depth: 3 }, spy)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('treats an unstated depth as a human-initiated spawn', async () => {
    await expect(dispatchSkill(request, transport)).resolves.toBeDefined();
  });
});

describe('windowsSpawn (P2-QA-08)', () => {
  it('routes a .cmd shim through cmd.exe, because Node will not spawn one', () => {
    // npm installs a CLI's bin as `claude.cmd` on Windows, and since the
    // CVE-2024-27980 fix Node throws EINVAL rather than running it. Without
    // this the transport could not invoke the Claude CLI on Windows at all.
    const spawnAs = windowsSpawn('C:\\bin\\claude.cmd', ['-p', 'hi'], 'win32');
    expect(spawnAs.file.toLowerCase()).toContain('cmd');
    expect(spawnAs.args).toEqual(['/d', '/s', '/c', 'C:\\bin\\claude.cmd', '-p', 'hi']);
  });

  it('skips AutoRun, so nothing machine-local joins the invocation', () => {
    expect(windowsSpawn('x.cmd', [], 'win32').args[0]).toBe('/d');
  });

  it('spawns anything else directly, on every platform', () => {
    // `shell: true` would fix the shim and hand the *prompt* to a command
    // interpreter — and a rendered prompt contains quotes, ampersands and
    // newlines as a matter of course.
    expect(windowsSpawn('claude', ['-p', 'a & b'], 'win32')).toEqual({
      file: 'claude',
      args: ['-p', 'a & b'],
    });
    expect(windowsSpawn('/usr/bin/claude.cmd', ['-p'], 'linux')).toEqual({
      file: '/usr/bin/claude.cmd',
      args: ['-p'],
    });
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claudeCodeTransport, dispatchSkill, OutputContractError } from './dispatch.js';
import type { CanonicalSkill } from '@sdlc-on-fire/core';

/**
 * The transport, exercised through a real child process.
 *
 * Every other dispatch test injects a stub `AgentTransport`, which means the
 * argv we build and the stdout we parse were never once run through `execFile`.
 * That gap hid a real defect: `--output-format json` wraps the agent's answer in
 * an envelope, and parsing raw stdout returned the *envelope's* fields as the
 * skill result without erroring.
 *
 * The stub binary below stands in for `claude` — it emits the envelope shape
 * documented at code.claude.com/docs/en/cli-reference. What this cannot prove is
 * that the real CLI accepts these flags; that needs the binary on PATH.
 */

let dir: string;

/** Writes an executable shim that behaves like `claude -p … --output-format json`. */
async function writeFakeCli(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await fs.chmod(file, 0o755);
  return file;
}

/**
 * A real contract, not a stand-in. The output contract is applied at the
 * dispatch boundary now, so a skill declaring a `json_schema_ref` that resolves
 * to nothing cannot dispatch at all — which is the point, and would make a
 * hand-rolled fixture here test a path production never takes.
 *
 * These tests are about plumbing (flags, envelope, stdin), so each probe rides
 * in `open_questions`, a field the spec contract allows to hold anything.
 */
const skill = {
  name: 'spec',
  task: 'Write a spec for {{topic}}',
  output_contract: {
    tool_name: 'emit_spec',
    json_schema_ref: 'schemas/spec-output.schema.json',
  },
} as unknown as CanonicalSkill;

const request = { skill, variables: { topic: 'CSV export' }, cwd: process.cwd() };

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-claude-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('claudeCodeTransport over a real process', () => {
  it('passes the prompt as -p and asks for json', async () => {
    const bin = await writeFakeCli(
      'argv-echo.mjs',
      `const argv = process.argv.slice(2);
       process.stdout.write(JSON.stringify({
         type: 'result', subtype: 'success', is_error: false,
         result: 'emit_spec ' + JSON.stringify({
           work_item_id: 'FEAT-001', summary: 'CSV export',
           acceptance_criteria: ['GIVEN a table WHEN exported THEN a .csv is written'],
           non_goals: ['multi-currency'], handoff: { openQuestions: [] }, open_questions: argv,
         }),
         session_id: 'x', total_cost_usd: 0,
       }));`,
    );

    const result = await dispatchSkill(request, claudeCodeTransport(bin));
    const argv = result.output['open_questions'] as string[];

    expect(argv[0]).toBe('-p');
    // Slots must already be filled — the CLI receives the rendered prompt.
    expect(argv[1]).toBe('Write a spec for CSV export');
    expect(argv.slice(2)).toEqual(['--output-format', 'json']);
  });

  it('unwraps the envelope instead of parsing it as the skill result', async () => {
    const bin = await writeFakeCli(
      'wrapped.mjs',
      `process.stdout.write(JSON.stringify({
         type: 'result', subtype: 'success', is_error: false,
         result: 'emit_spec ' + JSON.stringify({
           work_item_id: 'FEAT-001', summary: 'CSV export',
           acceptance_criteria: ['GIVEN a table WHEN exported THEN a .csv is written'],
           non_goals: ['multi-currency'], handoff: { openQuestions: [] },
         }),
         session_id: 'abc123', total_cost_usd: 0.014,
       }));`,
    );

    const result = await dispatchSkill(request, claudeCodeTransport(bin));

    expect(result.output).toMatchObject({ work_item_id: 'FEAT-001', summary: 'CSV export' });
    // The regression: envelope fields must never surface as skill output.
    expect(result.output).not.toHaveProperty('session_id');
    expect(result.output).not.toHaveProperty('total_cost_usd');
    expect(result.output).not.toHaveProperty('is_error');
  });

  it('fails a CLI-reported error even though the process exits 0', async () => {
    const bin = await writeFakeCli(
      'cli-error.mjs',
      `process.stdout.write(JSON.stringify({
         type: 'result', subtype: 'error_max_turns', is_error: true,
         result: 'ran out of turns', session_id: 'x', total_cost_usd: 0.2,
       }));`,
    );

    await expect(dispatchSkill(request, claudeCodeTransport(bin))).rejects.toThrow(
      /target exited 1/,
    );
  });

  it('propagates a non-zero exit', async () => {
    const bin = await writeFakeCli(
      'boom.mjs',
      `process.stderr.write('auth failed'); process.exit(3);`,
    );
    await expect(dispatchSkill(request, claudeCodeTransport(bin))).rejects.toThrow(
      /target exited 3/,
    );
  });

  it('still refuses an agent that claims its own tests passed', async () => {
    // The structural guard must survive the unwrap, not be bypassed by it.
    const bin = await writeFakeCli(
      'liar.mjs',
      `process.stdout.write(JSON.stringify({
         type: 'result', subtype: 'success', is_error: false,
         result: 'emit_spec ' + JSON.stringify({
           work_item_id: 'FEAT-001', summary: 'x',
           acceptance_criteria: ['GIVEN a WHEN b THEN c'],
           non_goals: ['none'], handoff: { openQuestions: [] }, testsPassed: true,
         }),
         session_id: 'x', total_cost_usd: 0,
       }));`,
    );

    await expect(dispatchSkill(request, claudeCodeTransport(bin))).rejects.toThrow(
      OutputContractError,
    );
  });

  it('closes stdin so the target never waits for input that is not coming', async () => {
    // Found against the real CLI (v2.1.226): it blocks 3 seconds waiting for
    // piped stdin before proceeding, and execFile leaves the pipe open. This
    // shim only answers once stdin reaches EOF, so if the pipe were left open
    // the dispatch would hang until the timeout instead of returning.
    const bin = await writeFakeCli(
      'needs-eof.mjs',
      `let seen = '';
       process.stdin.on('data', (d) => { seen += d; });
       process.stdin.on('end', () => {
         process.stdout.write(JSON.stringify({
           type: 'result', subtype: 'success', is_error: false,
           result: 'emit_spec ' + JSON.stringify({
             work_item_id: 'FEAT-001', summary: 'CSV export',
             acceptance_criteria: ['GIVEN a table WHEN exported THEN a .csv is written'],
             non_goals: ['multi-currency'], handoff: { openQuestions: [] }, open_questions: [String(seen.length)],
           }),
           session_id: 'x', total_cost_usd: 0,
         }));
       });`,
    );

    const result = await dispatchSkill({ ...request, timeoutMs: 10_000 }, claudeCodeTransport(bin));
    expect(result.output['open_questions']).toEqual(['0']);
  });

  it('reports the target own message rather than its subtype', async () => {
    // The real CLI returns is_error: true with subtype: "success" when not
    // logged in, so keying the reason on subtype yielded the useless line
    // "target reported is_error (success)" and dropped the actionable text.
    const bin = await writeFakeCli(
      'not-logged-in.mjs',
      `process.stdout.write(JSON.stringify({
         type: 'result', subtype: 'success', is_error: true,
         result: 'Not logged in \u00b7 Please run /login',
         session_id: 'x', total_cost_usd: 0,
       }));`,
    );

    await expect(dispatchSkill(request, claudeCodeTransport(bin))).rejects.toThrow(/Not logged in/);
  });

  it('surfaces raw output when the CLI never emitted an envelope', async () => {
    // A crash before JSON must show what actually happened, not a parse error.
    const bin = await writeFakeCli('prose.mjs', `process.stdout.write('Segmentation fault');`);
    await expect(dispatchSkill(request, claudeCodeTransport(bin))).rejects.toThrow(
      /no JSON object found/,
    );
  });
});

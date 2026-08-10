import { execFile } from 'node:child_process';
import type { CanonicalSkill } from '@sdlc-on-fire/core';
import { fillSlots } from './prompt.js';

/**
 * Agent dispatch — the `invoke` leg of the `AgentAdapter` (P1-AGENT-11, Q-11).
 *
 * `compileSkill` writes a skill onto a target's surface. This runs it. Without
 * it the product compiles skills nobody invokes, which is the gap the
 * end-to-end exercise found.
 *
 * The invariant that survives here unchanged: **the agent never reports whether
 * verify passed.** It returns a structured result describing what it did; the
 * daemon runs the commands and reads the output itself (architecture §5). A
 * dispatcher that accepted a `testsPassed: true` field would quietly undo the
 * whole product.
 */

export class DispatchError extends Error {
  override readonly name = 'DispatchError';
  constructor(
    readonly skill: string,
    message: string,
    readonly stderr?: string | undefined,
  ) {
    super(`dispatch of "${skill}" failed: ${message}`);
  }
}

export class OutputContractError extends Error {
  override readonly name = 'OutputContractError';
  constructor(
    readonly skill: string,
    readonly toolName: string,
    message: string,
  ) {
    super(`"${skill}" did not honour its output contract (${toolName}): ${message}`);
  }
}

export interface DispatchRequest {
  readonly skill: CanonicalSkill;
  /** Values for the skill's `{{slot}}` variables. */
  readonly variables: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs?: number | undefined;
}

export interface DispatchResult {
  readonly skill: string;
  readonly target: string;
  /** The structured payload the skill emitted through its output contract. */
  readonly output: Record<string, unknown>;
  readonly durationMs: number;
  /** Raw stdout, retained so a human can see what actually happened. */
  readonly raw: string;
}

/**
 * How a target is executed. Injectable so dispatch is testable without spending
 * tokens on a real model — and so a second target is a new transport, not a
 * rewrite.
 */
export type AgentTransport = (input: {
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Fields a skill result must never carry — verifying is the daemon's job, not the agent's. */
export const FORBIDDEN_OUTPUT_FIELDS = [
  'testsPassed',
  'tests_passed',
  'verified',
  'gatePassed',
  'gate_passed',
  'buildOk',
  'build_ok',
] as const;

/**
 * Extracts the tool-call payload from a target's stdout.
 *
 * Looks for the skill's declared tool name followed by a JSON object, which is
 * what the output contract asked for. A skill that answered in prose gets an
 * `OutputContractError` rather than a best-effort guess at what it meant.
 */
export function extractToolOutput(stdout: string, skill: CanonicalSkill): Record<string, unknown> {
  const marker = skill.output_contract.tool_name;
  const at = stdout.lastIndexOf(marker);
  const searchFrom = at === -1 ? 0 : at + marker.length;

  const start = stdout.indexOf('{', searchFrom);
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new OutputContractError(skill.name, marker, 'no JSON object found in the output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch (cause) {
    throw new OutputContractError(
      skill.name,
      marker,
      `payload is not valid JSON (${(cause as Error).message})`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OutputContractError(skill.name, marker, 'payload must be a JSON object');
  }

  const output = parsed as Record<string, unknown>;

  // The structural guard. An agent asserting its own tests passed is exactly
  // the claim the evidence gate exists to refuse, so it is rejected at the
  // boundary rather than silently carried into a run record.
  const forbidden = FORBIDDEN_OUTPUT_FIELDS.filter((field) => field in output);
  if (forbidden.length > 0) {
    throw new OutputContractError(
      skill.name,
      marker,
      `output claims verification results (${forbidden.join(', ')}) — the daemon runs verify, not the agent`,
    );
  }

  return output;
}

/**
 * Dispatches a skill through a transport and returns its structured result.
 *
 * The prompt is the skill's template with its slots filled — the same renderer
 * the compiler uses, so what runs is what was compiled.
 */
export async function dispatchSkill(
  request: DispatchRequest,
  transport: AgentTransport,
  target = 'claude-code',
): Promise<DispatchResult> {
  const prompt = fillSlots(request.skill.task, request.variables);
  const timeoutMs = request.timeoutMs ?? 600_000;
  const startedAt = Date.now();

  const result = await transport({ prompt, cwd: request.cwd, timeoutMs });
  const durationMs = Date.now() - startedAt;

  if (result.exitCode !== 0) {
    throw new DispatchError(request.skill.name, `target exited ${result.exitCode}`, result.stderr);
  }

  return {
    skill: request.skill.name,
    target,
    output: extractToolOutput(result.stdout, request.skill),
    durationMs,
    raw: result.stdout,
  };
}

/**
 * Transport that shells out to the Claude Code CLI.
 *
 * Kept behind the `AgentTransport` seam so nothing else in the system knows a
 * CLI is involved — and so tests never need a model.
 */
export function claudeCodeTransport(binary = 'claude'): AgentTransport {
  return ({ prompt, cwd, timeoutMs }) =>
    new Promise((resolve) => {
      execFile(
        binary,
        ['-p', prompt, '--output-format', 'json'],
        { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
          });
        },
      );
    });
}

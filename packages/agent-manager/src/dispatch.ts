import { execFile } from 'node:child_process';
import { resolveOutputSchema } from './skills/output-schemas.js';
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

/**
 * A dispatch that did not produce a usable result.
 *
 * The target's own last words go in the message, not only on the `stderr`
 * property. "target exited 1" tells an operator nothing; "Not logged in ·
 * Please run /login" tells them exactly what to do, and that string was already
 * in hand — it was just parked somewhere nobody prints.
 */
export class DispatchError extends Error {
  override readonly name = 'DispatchError';
  constructor(
    readonly skill: string,
    message: string,
    readonly stderr?: string | undefined,
  ) {
    const detail = (stderr ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' — ');
    super(`dispatch of "${skill}" failed: ${message}${detail.length > 0 ? ` (${detail})` : ''}`);
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

  // The declared schema, actually applied. Until now `json_schema_ref` named a
  // file that did not exist and nothing validated against it, so the "output
  // contract" was a sentence in a prompt: an agent could emit any JSON object at
  // all and the only rejection it risked was the forbidden-field guard above.
  const schema = resolveOutputSchema(skill.output_contract.json_schema_ref);
  if (schema === undefined) {
    throw new OutputContractError(
      skill.name,
      marker,
      `declares json_schema_ref "${skill.output_contract.json_schema_ref}", which resolves to nothing — ` +
        'a contract that cannot be applied is not a contract',
    );
  }
  const validated = schema.safeParse(output);
  if (!validated.success) {
    throw new OutputContractError(
      skill.name,
      marker,
      `output does not satisfy ${skill.output_contract.json_schema_ref}: ` +
        validated.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
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
 * The result envelope `claude -p --output-format json` prints.
 *
 * Only the fields we depend on; the CLI sends more (`session_id`,
 * `total_cost_usd`, `duration_ms`) that we deliberately do not couple to.
 * Field names per the CLI reference at code.claude.com/docs/en/cli-reference.
 */
interface ClaudeCliEnvelope {
  readonly result?: unknown;
  readonly is_error?: unknown;
  readonly subtype?: unknown;
}

/**
 * Unwraps the CLI's JSON envelope down to the agent's own text.
 *
 * This is not cosmetic. `--output-format json` prints a wrapper object, so
 * handing raw stdout to `extractToolOutput` makes it parse the *wrapper* — and
 * because the wrapper is a valid JSON object, that path does not fail, it
 * silently returns `{result, is_error, session_id, …}` as though the skill had
 * produced it. A dispatch that fabricates a plausible result is the precise
 * failure this system exists to prevent, so the unwrap lives here, in the one
 * place that knows which flags were passed.
 *
 * Anything that is not the expected envelope is passed through untouched: a CLI
 * that crashed before emitting JSON should surface its actual stderr, not a
 * parse error about it.
 */
function unwrapCliEnvelope(stdout: string): { text: string; failed: boolean; reason?: string } {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return { text: stdout, failed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: stdout, failed: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { text: stdout, failed: false };
  }

  const envelope = parsed as ClaudeCliEnvelope;
  if (typeof envelope.result !== 'string') return { text: stdout, failed: false };

  if (envelope.is_error === true) {
    // Report the message, not the subtype. Verified against the real CLI
    // (v2.1.226): a not-logged-in failure comes back as `is_error: true` with
    // `subtype: "success"`, so keying the reason on subtype produced the
    // useless line "target reported is_error (success)" and threw away the one
    // string a human needed — "Not logged in · Please run /login".
    const detail = envelope.result.trim();
    const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : 'unknown';
    return {
      text: envelope.result,
      failed: true,
      reason:
        detail.length > 0
          ? `target reported is_error: ${detail}`
          : `target reported is_error (subtype ${subtype}, no message)`,
    };
  }
  return { text: envelope.result, failed: false };
}

/**
 * Transport that shells out to the Claude Code CLI.
 *
 * Kept behind the `AgentTransport` seam so nothing else in the system knows a
 * CLI is involved — and so tests never need a model.
 *
 * Invocation is `-p <prompt> --output-format json`, verified against the CLI
 * reference (code.claude.com/docs/en/cli-reference) and against the real binary
 * (v2.1.226) on 2026-08-10.
 */
export function claudeCodeTransport(binary = 'claude'): AgentTransport {
  return ({ prompt, cwd, timeoutMs }) =>
    new Promise((resolve) => {
      const child = execFile(
        binary,
        ['-p', prompt, '--output-format', 'json'],
        { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const unwrapped = unwrapCliEnvelope(stdout);
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({
            stdout: unwrapped.text,
            // A CLI-reported error exits 0 but sets `is_error`; surface it as a
            // failure so `dispatchSkill` raises instead of parsing an apology.
            stderr: unwrapped.failed ? `${stderr}\n${unwrapped.reason ?? ''}`.trim() : stderr,
            exitCode: unwrapped.failed && exitCode === 0 ? 1 : exitCode,
          });
        },
      );

      // Close stdin immediately. The real CLI blocks for 3 seconds waiting for
      // piped input before giving up ("no stdin data received in 3s"), and
      // `execFile` leaves the pipe open — so every dispatch paid three seconds
      // for input that is never coming. We pass the prompt in argv; there is no
      // stdin leg to this protocol.
      child.stdin?.end();
    });
}

import { execFile } from 'node:child_process';
import os from 'node:os';
import { computeConfidence, type EvidenceEnvelope, type EvidenceKind } from '@sdlc-on-fire/core';
import { parseBuildResult, parseTscOutput, parseVitestJson, payloadHash } from './parsers.js';
import { parseDependencyAudit } from './dependency-audit.js';

/**
 * The verify runner — **the daemon executes the command, never the agent**
 * (architecture §5, the invariant the whole product rests on).
 *
 * Everything here produces `producer: "daemon"` envelopes from raw captured
 * output. An agent's report of what a command printed is not an input to this
 * module at any point.
 */

export interface RunContext {
  readonly cwd: string;
  readonly gitSha: string;
  readonly dirtyTreeHash?: string | undefined;
  /** Tool versions recorded for audit/repro; never used in the pass/fail computation. */
  readonly toolVersions?: Record<string, string> | undefined;
  readonly now?: Date | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/**
 * Runs a command and captures its output.
 *
 * A non-zero exit is **data, not an exception** — a failing test run is exactly
 * the evidence the gate needs, and throwing would discard it.
 */
export async function runCommand(
  cmd: string,
  args: readonly string[],
  context: RunContext,
): Promise<CommandResult> {
  const startedAt = Date.now();

  return new Promise<CommandResult>((resolve) => {
    execFile(
      cmd,
      [...args],
      { cwd: context.cwd, timeout: context.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ stdout, stderr, exitCode, durationMs });
      },
    );
  });
}

function envelope(
  kind: EvidenceKind,
  payload: unknown,
  command: { cmd: string; args: readonly string[]; exitCode: number },
  context: RunContext,
  /**
   * Overrides the computed confidence.
   *
   * Used by the dependency audit, whose payload is a point-in-time claim about
   * the ecosystem rather than an observation of this code — it can go out of
   * date without anything changing here, and saying so in the number is more
   * honest than letting it read like a test run.
   */
  confidenceOverride?: number,
): EvidenceEnvelope {
  const producedAt = (context.now ?? new Date()).toISOString();

  const base: EvidenceEnvelope = {
    kind,
    // The daemon ran it and captured the output directly. There is no
    // agent-reported intermediary anywhere in this path.
    producer: 'daemon',
    git_sha: context.gitSha,
    env: {
      tool_versions: context.toolVersions ?? { node: process.version },
      os: `${os.platform()}-${os.release()}`,
    },
    command: {
      cmd: command.cmd,
      args: [...command.args],
      cwd: context.cwd,
      exit_code: command.exitCode,
    },
    content_hash: payloadHash(payload),
    confidence:
      confidenceOverride ?? computeConfidence({ producer: 'daemon', produced_at: producedAt }),
    produced_at: producedAt,
    payload,
  };

  // `dirty_tree_hash` is set only when there genuinely is uncommitted state —
  // an always-present field would make every envelope look provisional.
  return context.dirtyTreeHash === undefined
    ? base
    : { ...base, dirty_tree_hash: context.dirtyTreeHash };
}

/** Runs a Vitest/Jest suite with the JSON reporter and produces `test` evidence. */
export async function runTests(
  cmd: string,
  args: readonly string[],
  context: RunContext,
): Promise<EvidenceEnvelope> {
  const result = await runCommand(cmd, args, context);
  // Runners print progress to stderr and the report to stdout; some prepend
  // noise, so take the JSON document rather than the whole stream.
  const payload = parseVitestJson(extractJson(result.stdout));
  return envelope('test', payload, { cmd, args, exitCode: result.exitCode }, context);
}

export async function runTypecheck(
  cmd: string,
  args: readonly string[],
  context: RunContext,
): Promise<EvidenceEnvelope> {
  const result = await runCommand(cmd, args, context);
  const payload = parseTscOutput(`${result.stdout}\n${result.stderr}`, result.exitCode);
  return envelope('typecheck', payload, { cmd, args, exitCode: result.exitCode }, context);
}

export async function runBuild(
  cmd: string,
  args: readonly string[],
  context: RunContext,
): Promise<EvidenceEnvelope> {
  const result = await runCommand(cmd, args, context);
  const payload = parseBuildResult({
    cmd: `${cmd} ${args.join(' ')}`.trim(),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  });
  return envelope('build', payload, { cmd, args, exitCode: result.exitCode }, context);
}

/**
 * Pulls the JSON document out of a stream that may carry leading progress noise.
 *
 * Returns the input unchanged when no object is found, so the parser reports a
 * specific "not valid JSON" error rather than this function silently returning
 * an empty string that would parse as nothing.
 */
export function extractJson(stream: string): string {
  const start = stream.indexOf('{');
  const end = stream.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return stream;
  return stream.slice(start, end + 1);
}

/**
 * Runs a dependency audit and produces `security-scan` evidence (P1-GATE-10).
 *
 * The audit tool exits **non-zero when it finds anything**, which is not a
 * failure of the run: it found what it was asked to find. Treating that exit
 * code as an error would discard the very report we came for — the same mistake
 * the test runner path deliberately avoids.
 *
 * `confidence` is lower than a test run's on purpose. An advisory database is a
 * point-in-time claim about the ecosystem that can change without any code
 * changing, and evidence that overstates its own certainty is worse than
 * evidence that is merely old.
 */
export async function runDependencyAudit(
  cmd: string,
  args: readonly string[],
  context: RunContext,
): Promise<EvidenceEnvelope> {
  const result = await runCommand(cmd, args, context);
  const payload = parseDependencyAudit(
    extractJson(result.stdout),
    `${cmd} ${args.join(' ')}`.trim(),
  );
  return envelope('security-scan', payload, { cmd, args, exitCode: result.exitCode }, context, 0.7);
}

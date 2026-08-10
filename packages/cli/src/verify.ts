import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { EvidenceEnvelopeSchema, type EvidenceEnvelope } from '@sdlc-on-fire/core';
import { parseVitestJson, payloadHash } from '@sdlc-on-fire/evidence';

/**
 * Running the work item's own `verify:` command (P1-GATE-01 wiring).
 *
 * This is the piece a blind evaluation found missing, and its absence made the
 * entire product a no-op: every card carried a concrete `verify:` command, the
 * gate could evaluate evidence, the lifecycle engine could refuse a transition —
 * and nothing ever ran the command, so there was never any evidence to evaluate
 * and nothing to refuse.
 *
 * **We** run it. Not the agent. The agent's report of the outcome is exactly the
 * claim this product exists to disbelieve, so the only thing that produces
 * `producer: 'daemon'` evidence is this function actually executing the command
 * and reading its exit code.
 */

const run = promisify(execFile);

export interface VerifyOutcome {
  readonly command: string;
  readonly exitCode: number;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly envelope: EvidenceEnvelope;
}

/**
 * Executes a verify command and turns the result into an evidence envelope.
 *
 * A non-zero exit is a *result*, not an error: "the tests failed" is the single
 * most important thing this can learn, and throwing would turn it into a stack
 * trace instead of evidence.
 */
export async function runVerify(input: {
  readonly command: string;
  readonly cwd: string;
  readonly gitSha: string;
  readonly dirtyTreeHash?: string | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<VerifyOutcome> {
  const startedAt = Date.now();
  let stdout: string;
  let stderr: string;
  let exitCode = 0;

  try {
    const result = await run('/bin/sh', ['-c', input.command], {
      cwd: input.cwd,
      timeout: input.timeoutMs ?? 600_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? String(cause);
    exitCode = typeof error.code === 'number' ? error.code : 1;
  }

  const durationMs = Date.now() - startedAt;
  const ok = exitCode === 0;

  // Prefer a structured parse when the runner produced one; fall back to the
  // exit code. An exit code is a weaker signal than a parsed report, but it is
  // never a *wrong* one, and pretending we know test counts we did not read
  // would be inventing evidence.
  let payload: unknown;
  try {
    payload = parseVitestJson(stdout);
  } catch {
    payload = {
      runner: 'shell',
      total: 0,
      passed: 0,
      failed: ok ? 0 : 1,
      ok,
      failures: ok
        ? []
        : [{ file: '(unknown)', title: input.command, message: stderr.slice(0, 2_000) }],
    };
  }

  const envelope = EvidenceEnvelopeSchema.parse({
    kind: 'test',
    // The daemon ran it. This is the whole distinction the gate turns on.
    producer: 'daemon',
    git_sha: input.gitSha,
    ...(input.dirtyTreeHash === undefined ? {} : { dirty_tree_hash: input.dirtyTreeHash }),
    env: { tool_versions: { node: process.version }, os: `${os.platform()}-${os.arch()}` },
    command: { cmd: '/bin/sh', args: ['-c', input.command], cwd: input.cwd, exit_code: exitCode },
    content_hash: payloadHash(payload),
    confidence: 0.95,
    produced_at: new Date().toISOString(),
    payload,
  });

  return { command: input.command, exitCode, ok, stdout, stderr, durationMs, envelope };
}

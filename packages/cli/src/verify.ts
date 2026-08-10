import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { EvidenceEnvelopeSchema, type EvidenceEnvelope } from '@sdlc-on-fire/core';
import { parseRunnerOutput, parseVitestJson, payloadHash } from '@sdlc-on-fire/evidence';
import {
  maskEnvironment,
  SandboxConfigSchema,
  type SandboxConfig,
  type SandboxResolution,
} from '@sdlc-on-fire/core';
import { runGuarded, sandboxCommand, type GuardedRun } from '@sdlc-on-fire/daemon';

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
  /** What confinement was actually applied, and why. Never inferred by a caller. */
  readonly sandbox: SandboxResolution;
  /** Whether the watchdog cut the run short, and how. */
  readonly limitOutcome: 'completed' | 'timeout' | 'output-exceeded';
}

/**
 * Executes a verify command and turns the result into an evidence envelope.
 *
 * A non-zero exit is a *result*, not an error: "the tests failed" is the single
 * most important thing this can learn, and throwing would turn it into a stack
 * trace instead of evidence.
 */
/**
 * Hashes the uncommitted working tree.
 *
 * Without this, evidence produced against uncommitted changes records only the
 * commit SHA — and a later edit that is *also* uncommitted leaves the SHA
 * unchanged, so the staleness check sees current evidence for code that has
 * since changed. An adversarial evaluation walked a work item to `done` through
 * that gap using nothing but blessed commands.
 *
 * `git status --porcelain` plus the diff covers both tracked edits and new
 * files. An unreadable tree hashes to a unique sentinel rather than to nothing:
 * "we could not tell" must never collapse into "nothing changed".
 */
export async function currentDirtyTreeHash(cwd: string): Promise<string | undefined> {
  // The workspace's own bookkeeping is excluded deliberately. Advancing a work
  // item rewrites its card, and if that counted as a change to the tree then
  // every successful `advance` would immediately invalidate the very evidence
  // that permitted it — the gate would flag its own correct outcome. The
  // question this hash answers is "has the code under test changed", and a
  // lifecycle field is not the code under test.
  const excludes = [':(exclude)kanban', ':(exclude).sdlcof', ':(exclude)docs'];
  try {
    // Not a repository at all is a different answer from "we could not read the
    // tree". Collapsing them made every non-git workspace produce a fresh
    // time-based sentinel on each call, so its evidence went stale the instant
    // it was written and `advance` refused forever — with a message telling the
    // user to run the command they had just run. A blind evaluation hit exactly
    // that and retried six times before giving up.
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    return undefined;
  }

  try {
    // File *contents*, not `git diff`. A diff against HEAD needs a HEAD, and a
    // repository with no commit yet is the normal state for a workspace on its
    // first day — the earlier version fell into its own error path there and
    // produced a fresh sentinel hash on every call, so evidence was stale the
    // instant it was written.
    const status = await run(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', '.', ...excludes],
      { cwd },
    );
    const paths = status.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.slice(3).trim())
      // A rename reports "old -> new"; the new path is the one that exists.
      .map((entry) => entry.split(' -> ').at(-1) ?? entry)
      .map((entry) => (entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry))
      .sort();

    if (paths.length === 0) return undefined; // genuinely clean

    const hash = createHash('sha256');
    for (const relative of paths) {
      // A deleted file hashes as its absence rather than being skipped: deleting
      // the code the tests covered must not look like no change at all.
      const contents = await readFile(path.join(cwd, relative)).catch(() =>
        Buffer.from('\0absent'),
      );
      hash.update(relative, 'utf8').update('\0').update(contents).update('\0');
    }
    return hash.digest('hex');
  } catch {
    return createHash('sha256').update(`unreadable-tree:${Date.now().toString()}`).digest('hex');
  }
}

export async function runVerify(input: {
  readonly command: string;
  readonly cwd: string;
  readonly gitSha: string;
  readonly dirtyTreeHash?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Off unless the workspace configured it (ADR-0036, P1-SEC-02). */
  readonly sandbox?: SandboxConfig | undefined;
}): Promise<VerifyOutcome> {
  const startedAt = Date.now();
  let stdout = '';
  let stderr: string;
  let exitCode: number;

  // The sandbox is a backstop, not a replacement for judgement about what to
  // run: the boundary holds regardless of what command the card declared. It
  // never degrades silently — `resolution` records what was actually applied,
  // and the envelope carries it, so evidence cannot imply a confinement that
  // was not in force.
  const sandboxConfig = input.sandbox ?? SandboxConfigSchema.parse({});
  let guarded: GuardedRun | undefined;
  const sandboxed = await sandboxCommand({
    command: input.command,
    workspaceRoot: input.cwd,
    config: sandboxConfig,
  });

  // Credentials the command must not hold become per-session sentinels, so a
  // run that exfiltrates its whole environment exfiltrates worthless strings
  // (P1-SEC-03). This holds whatever the model decided to run, which is a
  // different kind of protection from having told it not to.
  const masked = maskEnvironment(
    process.env,
    sandboxConfig.credentials.envVars,
    `${input.gitSha}:${String(startedAt)}`,
  );

  try {
    // The watchdog, not `execFile`'s timeout: it kills the whole process group,
    // and a `pnpm test` that spawns workers otherwise leaves them running with
    // their parent gone (P1-SEC-04, ADR-0036).
    const result = await runGuarded(sandboxed.cmd, sandboxed.args, {
      cwd: input.cwd,
      limits: {
        ...sandboxConfig.limits,
        ...(input.timeoutMs === undefined
          ? {}
          : { timeoutSeconds: Math.ceil(input.timeoutMs / 1000) }),
      },
      env: masked.env,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
    guarded = result;
  } catch (cause) {
    stderr = String(cause);
    exitCode = 1;
  } finally {
    await sandboxed.cleanup?.();
  }

  const durationMs = Date.now() - startedAt;
  const ok = exitCode === 0;

  // Prefer a structured parse when the runner produced one; fall back to the
  // exit code. An exit code is a weaker signal than a parsed report, but it is
  // never a *wrong* one, and pretending we know test counts we did not read
  // would be inventing evidence.
  //
  // `report` records *which* of those two we got. It matters because an exit
  // code alone cannot tell `pnpm test` from `verify: true` — both exit 0, and an
  // adversarial evaluation reached `done` by pointing `verify:` at a no-op.
  // Recording the distinction lets every read path say "verified by exit code
  // only" instead of implying a suite that was never observed.
  let payload: unknown;
  try {
    const parsed = parseVitestJson(stdout);
    payload = { ...parsed, report: 'parsed' as const };
  } catch {
    // Not JSON — try the formats real runners actually print. Until this
    // existed, an honest `node --test` run and a fabricated `echo PASS && exit 0`
    // produced identical evidence, so nothing downstream (and no human reading
    // the PR) could tell them apart.
    const fromRunner = parseRunnerOutput(`${stdout}\n${stderr}`);
    payload =
      fromRunner !== null
        ? { ...fromRunner, report: 'parsed' as const }
        : {
            runner: 'shell',
            total: 0,
            passed: 0,
            failed: ok ? 0 : 1,
            ok,
            report: 'exit-code-only' as const,
            failures: ok
              ? []
              : [{ file: '(unknown)', title: input.command, message: stderr.slice(0, 2_000) }],
          };
  }

  const dirty = input.dirtyTreeHash ?? (await currentDirtyTreeHash(input.cwd));

  const envelope = EvidenceEnvelopeSchema.parse({
    kind: 'test',
    // The daemon ran it. This is the whole distinction the gate turns on.
    producer: 'daemon',
    git_sha: input.gitSha,
    ...(dirty === undefined ? {} : { dirty_tree_hash: dirty }),
    env: { tool_versions: { node: process.version }, os: `${os.platform()}-${os.arch()}` },
    // The *declared* command, not the sandbox wrapper. Evidence is bound to
    // this string (v006), and recording `sandbox-exec -f /tmp/…` would make the
    // binding compare a wrapper path that changes on every run.
    command: { cmd: '/bin/sh', args: ['-c', input.command], cwd: input.cwd, exit_code: exitCode },
    content_hash: payloadHash(payload),
    // An unparsed report is a weaker observation, and the number says so rather
    // than flattering it.
    confidence: (payload as { report?: string }).report === 'parsed' ? 0.95 : 0.6,
    produced_at: new Date().toISOString(),
    payload,
  });

  return {
    command: input.command,
    exitCode,
    ok,
    stdout,
    stderr,
    durationMs,
    envelope,
    sandbox: sandboxed.resolution,
    // Reported, never inferred: a run cut short by the watchdog is not a failing
    // test suite, and conflating them would send someone to debug code that was
    // never given time to finish.
    limitOutcome: guarded?.outcome ?? 'completed',
  };
}

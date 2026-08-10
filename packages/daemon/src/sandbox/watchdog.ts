import { spawn } from 'node:child_process';
import { ResourceLimitsSchema, type ResourceLimits } from '@sdlc-on-fire/core';

/**
 * The watchdog for the shell-exec path (P1-SEC-04, ADR-0036).
 *
 * The limits themselves are vocabulary and live in core, because anything that
 * reads config needs to read them. What is here is the part that runs a process
 * and kills it — and specifically, kills its whole *group*.
 *
 * ADR-0036 names subprocess inheritance a correctness requirement rather than a
 * nicety: `pnpm test` spawns Vitest, which spawns workers, and killing only the
 * process you launched leaves the actual work running with its parent gone. A
 * timeout that does that has not stopped anything; it has stopped watching.
 */

export type LimitOutcome = 'completed' | 'timeout' | 'output-exceeded';

export interface GuardedRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly outcome: LimitOutcome;
  readonly durationMs: number;
  /** Limits declared but not enforceable on this platform. */
  readonly unenforced: readonly string[];
}

/**
 * Runs a command under the watchdog.
 *
 * `detached: true` puts the child in its own process group so a kill reaches
 * every descendant. Without it, `kill(pid)` signals one process and the workers
 * it spawned keep running — which is exactly the failure ADR-0036 calls out.
 */
export async function runGuarded(
  cmd: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly limits?: ResourceLimits | undefined;
    readonly platform?: string | undefined;
    /** Environment for the child — masked credentials arrive here (P1-SEC-03). */
    readonly env?: Readonly<Record<string, string>> | undefined;
  },
): Promise<GuardedRun> {
  const limits = options.limits ?? ResourceLimitsSchema.parse({});
  const platform = options.platform ?? process.platform;
  const unenforced: string[] = [];
  if (limits.memoryMb !== undefined && platform !== 'linux') {
    // No cgroups outside Linux. A silent no-op here would be a limit the user
    // believes in and does not have.
    unenforced.push(`memoryMb (cgroups are Linux-only; this is ${platform})`);
  }

  const startedAt = Date.now();

  return await new Promise<GuardedRun>((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      // Its own process group, so a kill reaches the whole tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outcome: LimitOutcome = 'completed';
    let settled = false;

    /** Signals the whole group. The negative pid is what makes it a group. */
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone, or the group was never created. Either way there is
        // nothing left to kill and nothing to report.
      }
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        outcome,
        durationMs: Date.now() - startedAt,
        unenforced,
      });
    };

    const timer = setTimeout(() => {
      outcome = 'timeout';
      killGroup('SIGTERM');
      // A grace period, then SIGKILL. A process ignoring SIGTERM is precisely
      // the case a watchdog exists for, so the escalation is not optional.
      setTimeout(() => killGroup('SIGKILL'), 2_000);
    }, limits.timeoutSeconds * 1_000);

    const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (into === 'out') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > limits.maxOutputBytes) {
        outcome = 'output-exceeded';
        stdout = stdout.slice(0, limits.maxOutputBytes);
        stderr = stderr.slice(0, limits.maxOutputBytes);
        killGroup('SIGKILL');
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      capture(chunk, 'out');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      capture(chunk, 'err');
    });

    child.on('error', (error) => {
      stderr += String(error);
      finish(127);
    });
    child.on('close', (code, signal) => {
      // A killed process reports a signal and a null code. Reporting 0 there
      // would make a timeout look like a success, which is the one thing this
      // must never do.
      finish(code ?? (signal === null ? 1 : 137));
    });
  });
}

/** Human-readable reason a run was cut short, or `null` when it finished. */
export function limitReason(run: GuardedRun, limits: ResourceLimits): string | null {
  if (run.outcome === 'timeout') {
    return `killed after ${String(limits.timeoutSeconds)}s — the whole process group, not just the command`;
  }
  if (run.outcome === 'output-exceeded') {
    return `killed after producing more than ${String(limits.maxOutputBytes)} bytes of output`;
  }
  return null;
}

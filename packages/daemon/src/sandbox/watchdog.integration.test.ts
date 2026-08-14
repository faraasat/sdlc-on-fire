import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResourceLimitsSchema } from '@sdlc-on-fire/core';
import { limitReason, runGuarded } from './watchdog.js';

/**
 * The watchdog (P1-SEC-04, ADR-0036).
 *
 * The subprocess-inheritance test is the one that matters. ADR-0036 names it a
 * correctness requirement rather than a nicety: `pnpm test` spawns Vitest which
 * spawns workers, and killing only the process you launched leaves the real work
 * running with its parent gone. A timeout that does that has not stopped
 * anything — it has only stopped watching.
 *
 * These run real child processes. A mock would prove the mock kills what I think
 * it kills, which is the assumption under test.
 *
 * **They run `node`, not `/bin/sh`.** They used to run the shell, which meant
 * they never ran at all on Windows — `/bin/sh` is not there, the spawn failed
 * immediately, and `runGuarded` dutifully reported a completed run with exit
 * 127. Every assertion below then read that as its answer: the timeout case saw
 * `completed` and the output cap saw no output, so a watchdog that killed
 * nothing on Windows was reported by a suite that had not started a process to
 * kill. Driving `node` directly is also the more honest test — the watchdog's
 * contract is about processes and their descendants, and the shell was never
 * part of it.
 */

let dir: string;

/** A child that does exactly what the case needs, on every platform. */
const node = (source: string): [string, string[]] => [process.execPath, ['-e', source]];

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('ordinary completion', () => {
  it('returns the output and the exit code', async () => {
    const [cmd, args] = node("process.stdout.write('hello\\n'); process.exit(3);");
    const run = await runGuarded(cmd, args, { cwd: dir });
    expect(run.stdout).toContain('hello');
    expect(run.exitCode).toBe(3);
    expect(run.outcome).toBe('completed');
    expect(limitReason(run, ResourceLimitsSchema.parse({}))).toBeNull();
  }, 60_000);
});

describe('the timeout', () => {
  it('kills a command that will not finish', async () => {
    const limits = ResourceLimitsSchema.parse({ timeoutSeconds: 1 });
    const [cmd, args] = node('setTimeout(() => {}, 30_000);');
    const run = await runGuarded(cmd, args, { cwd: dir, limits });

    expect(run.outcome).toBe('timeout');
    expect(run.durationMs).toBeLessThan(10_000);
    // A timeout must never look like success — that is the one thing a
    // watchdog cannot get wrong.
    expect(run.exitCode).not.toBe(0);
    expect(limitReason(run, limits)).toMatch(/whole process group/);
  }, 60_000);

  it('kills the grandchild too, not just the process it launched', async () => {
    // The whole point. A process that starts another and waits leaves that
    // other one running when only the first is killed; reaching the tree is
    // what stops it. This is the case that was silently unexercised on Windows,
    // and the case the Windows implementation had to be written for — there is
    // no process group there, so the tree is reached with `taskkill /T`.
    const marker = path.join(dir, 'grandchild-alive.txt');
    const limits = ResourceLimitsSchema.parse({ timeoutSeconds: 1 });

    // The grandchild is a file rather than a nested `-e` string. Escaping a
    // Windows path through two levels of source quoting is the kind of detail
    // that fails as a syntax error and gets read as a passing test, since a
    // grandchild that never started also never writes the marker.
    const grandchild = path.join(dir, 'grandchild.mjs');
    await fs.writeFile(
      grandchild,
      "import fs from 'node:fs';\nsetTimeout(() => fs.writeFileSync(process.argv[2], 'alive'), 6000);\n",
      'utf8',
    );

    const [cmd, args] = node(
      `const { spawn } = require('node:child_process');
       spawn(process.execPath, [process.argv[1], process.argv[2]], { stdio: 'ignore' });
       setTimeout(() => {}, 30_000);`,
    );

    await runGuarded(cmd, [...args, grandchild, marker], { cwd: dir, limits });

    // Give the grandchild longer than its own timer. If the tree kill worked,
    // it never wrote the file.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await expect(fs.stat(marker)).rejects.toThrow();
  }, 60_000);
});

describe('the output cap', () => {
  it('stops a command printing without bound', async () => {
    // This limit protects the *daemon*: an unbounded child fills our memory,
    // not its own.
    const limits = ResourceLimitsSchema.parse({ maxOutputBytes: 4096, timeoutSeconds: 20 });
    const [cmd, args] = node(
      "setInterval(() => process.stdout.write('flooding the pipe\\n'.repeat(64)), 1);",
    );
    const run = await runGuarded(cmd, args, { cwd: dir, limits });

    expect(run.outcome).toBe('output-exceeded');
    expect(run.stdout.length).toBeLessThanOrEqual(4096);
    expect(limitReason(run, limits)).toMatch(/more than 4096 bytes/);
  }, 60_000);
});

describe('what it cannot enforce', () => {
  it('says a memory cap is unenforceable off Linux rather than pretending', async () => {
    // A silent no-op here would be a limit the user believes in and does not
    // have — the same failure the sandbox tiers refuse to commit.
    const [cmd, args] = node('');
    const run = await runGuarded(cmd, args, {
      cwd: dir,
      limits: ResourceLimitsSchema.parse({ memoryMb: 512 }),
      platform: 'darwin',
    });
    expect(run.unenforced.join(' ')).toMatch(/cgroups are Linux-only/);
  }, 60_000);

  it('reports nothing unenforced when nothing was asked for', async () => {
    const [cmd, args] = node('');
    const run = await runGuarded(cmd, args, { cwd: dir, platform: 'darwin' });
    expect(run.unenforced).toEqual([]);
  }, 60_000);
});

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
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ordinary completion', () => {
  it('returns the output and the exit code', async () => {
    const run = await runGuarded('/bin/sh', ['-c', 'echo hello; exit 3'], { cwd: dir });
    expect(run.stdout).toContain('hello');
    expect(run.exitCode).toBe(3);
    expect(run.outcome).toBe('completed');
    expect(limitReason(run, ResourceLimitsSchema.parse({}))).toBeNull();
  }, 60_000);
});

describe('the timeout', () => {
  it('kills a command that will not finish', async () => {
    const limits = ResourceLimitsSchema.parse({ timeoutSeconds: 1 });
    const run = await runGuarded('/bin/sh', ['-c', 'sleep 30'], { cwd: dir, limits });

    expect(run.outcome).toBe('timeout');
    expect(run.durationMs).toBeLessThan(10_000);
    // A timeout must never look like success — that is the one thing a
    // watchdog cannot get wrong.
    expect(run.exitCode).not.toBe(0);
    expect(limitReason(run, limits)).toMatch(/whole process group/);
  }, 60_000);

  it('kills the grandchild too, not just the process it launched', async () => {
    // The whole point. A shell that spawns a background sleep and exits leaves
    // the sleep running; killing the group is what reaches it.
    const marker = path.join(dir, 'grandchild-alive.txt');
    const limits = ResourceLimitsSchema.parse({ timeoutSeconds: 1 });

    await runGuarded('/bin/sh', ['-c', `(sleep 6; echo alive > ${marker}) & wait`], {
      cwd: dir,
      limits,
    });

    // Give the grandchild longer than its own sleep. If the group kill worked,
    // it never wrote the file.
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    await expect(fs.stat(marker)).rejects.toThrow();
  }, 60_000);
});

describe('the output cap', () => {
  it('stops a command printing without bound', async () => {
    // This limit protects the *daemon*: an unbounded child fills our memory,
    // not its own.
    const limits = ResourceLimitsSchema.parse({ maxOutputBytes: 4096, timeoutSeconds: 20 });
    const run = await runGuarded('/bin/sh', ['-c', 'yes "flooding the pipe"'], {
      cwd: dir,
      limits,
    });

    expect(run.outcome).toBe('output-exceeded');
    expect(run.stdout.length).toBeLessThanOrEqual(4096);
    expect(limitReason(run, limits)).toMatch(/more than 4096 bytes/);
  }, 60_000);
});

describe('what it cannot enforce', () => {
  it('says a memory cap is unenforceable off Linux rather than pretending', async () => {
    // A silent no-op here would be a limit the user believes in and does not
    // have — the same failure the sandbox tiers refuse to commit.
    const run = await runGuarded('/bin/sh', ['-c', 'true'], {
      cwd: dir,
      limits: ResourceLimitsSchema.parse({ memoryMb: 512 }),
      platform: 'darwin',
    });
    expect(run.unenforced.join(' ')).toMatch(/cgroups are Linux-only/);
  }, 60_000);

  it('reports nothing unenforced when nothing was asked for', async () => {
    const run = await runGuarded('/bin/sh', ['-c', 'true'], { cwd: dir, platform: 'darwin' });
    expect(run.unenforced).toEqual([]);
  }, 60_000);
});

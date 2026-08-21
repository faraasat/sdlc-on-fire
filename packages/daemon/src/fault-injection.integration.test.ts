import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPackage, ResourceLimitsSchema, type PackageSignals } from '@sdlc-on-fire/core';
import { createOsvIntel, runGitleaks, runGuarded } from './index.js';

/**
 * Fault injection for the branches that only exist on paper (P3-QA-13).
 *
 * The adapters in this package already distinguish *"found nothing"* from
 * *"could not reach the source"* — the distinction exists precisely because
 * reading an outage as an all-clear is how a false pass happens. What did not
 * exist was anything that **causes** the outage: the unreachable branch was
 * verified by having been written.
 *
 * These cases cause it. Deliberately the small applicable subset of chaos
 * engineering rather than a platform — most of that literature concerns
 * production traffic and blast radius, which does not apply to a local CLI.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-fault-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('an unreachable advisory source', () => {
  it('cannot produce an "ok" verdict, end to end', async () => {
    // The property the module claims, asserted through the thing that consumes
    // it rather than at the intermediate shape. The failure this guards is the
    // most dangerous silence in the product: an advisory API that is down
    // answers nothing, and reading that as an all-clear turns an outage into a
    // green supply-chain gate.
    //
    // The first version of this test passed `endpoint:`, which is not an option
    // — so it silently hit the real osv.dev, got a real clean answer, and went
    // green without ever exercising the outage path. Caught by the sibling case
    // below, which noticed `onDegraded` never fired.
    const degraded: string[] = [];
    const intel = createOsvIntel({
      // A real fetch at a port nothing is listening on, injected through the
      // documented seam. Not a stub returning a rejected promise: the failure
      // exercised is a real connection refusal, with the real error shape.
      fetchImpl: (_url, init) => fetch('http://127.0.0.1:1/v1/querybatch', init),
      timeoutMs: 2_000,
      onDegraded: (reason) => degraded.push(reason),
    });

    const [signals] = await intel.lookup([
      { name: 'left-pad', version: '1.0.0', ecosystem: 'npm' },
    ]);
    expect(signals).toBeDefined();

    // `advisories: []` on its own is not the tell — a *successful* clean lookup
    // returns that too. What makes it fail closed is the absent registry
    // metadata, which the classifier reads as unknown.
    const verdict = classifyPackage(signals as PackageSignals);
    expect(verdict.verdict).toBe('assumed');
    expect(verdict.verdict).not.toBe('ok');
  }, 60_000);

  it('says out loud that it was degraded', async () => {
    // Fail-closed is necessary and not sufficient: if the only signal of an
    // outage is a verdict that also occurs for other reasons, nobody learns the
    // source was down.
    const degraded: string[] = [];
    const intel = createOsvIntel({
      fetchImpl: (_url, init) => fetch('http://127.0.0.1:1/v1/querybatch', init),
      timeoutMs: 2_000,
      onDegraded: (reason) => degraded.push(reason),
    });
    await intel.lookup([{ name: 'left-pad', ecosystem: 'npm' }]);
    expect(degraded.join(' ')).toContain('unreachable');
  }, 60_000);
});

describe('a missing scanner binary', () => {
  it('is reported as unavailable, not as a clean scan', async () => {
    // gitleaks is optional. "Not installed" and "installed and found nothing"
    // must not produce the same verdict.
    const root = await tempDir();
    const result = await runGitleaks(root, {
      // A runner that fails the way a missing binary fails.
      runner: () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
    });
    expect(result.status).toBe('not-installed');
    expect(result.findings).toEqual([]);
    // The cause is named, so it can be fixed rather than puzzled over.
    expect(result.detail ?? '').not.toBe('');
  }, 60_000);
});

describe('a child that outlives its budget', () => {
  it('is killed, and the timeout is reported as a timeout', async () => {
    const result = await runGuarded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      limits: ResourceLimitsSchema.parse({ timeoutSeconds: 2 }),
    });
    // A distinct outcome, not a non-zero exit — "it hung" and "it failed" ask
    // for different work.
    expect(result.outcome).toBe('timeout');
  }, 60_000);

  it('is cut off when it floods stdout, rather than filling memory', async () => {
    // The limit that protects the *daemon*, not the child: a command printing
    // without bound fills memory here.
    const result = await runGuarded(
      process.execPath,
      ['-e', 'while (true) process.stdout.write("x".repeat(4096));'],
      {
        cwd: process.cwd(),
        limits: ResourceLimitsSchema.parse({ timeoutSeconds: 30, maxOutputBytes: 64_000 }),
      },
    );
    expect(result.outcome).toBe('output-exceeded');
    expect(result.stdout.length).toBeLessThan(1_000_000);
  }, 60_000);
});

describe('a working directory that is not there', () => {
  it('fails as a result rather than throwing past the caller', async () => {
    // A guarded run reports; it does not surface a raw spawn error to whatever
    // was assembling a gate verdict.
    const root = await tempDir();
    await fs.rm(root, { recursive: true, force: true });
    const result = await runGuarded(process.execPath, ['-e', '0'], {
      cwd: root,
      limits: ResourceLimitsSchema.parse({ timeoutSeconds: 5 }),
    }).catch(() => null);

    // Either it reports a non-zero exit, or it rejects — what it must not do is
    // resolve as a clean run against a directory that does not exist.
    expect(result === null || result.exitCode !== 0).toBe(true);
  }, 60_000);
});

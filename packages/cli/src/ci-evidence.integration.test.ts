import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceEnvelopeSchema } from '@sdlc-on-fire/core';
import { init, openWorkspaceDatabase } from './commands.js';
import { ciEnvelope, ciEvidence, CheckFetchError, fetchCheckRuns } from './ci-evidence.js';
import { admitCheckRun } from '@sdlc-on-fire/core';

/**
 * `sdlc ci-evidence` against real PGlite and a stubbed provider (P6-SURFACE-07).
 *
 * The admission rules are unit-tested in core. What is only checkable here is
 * that an admitted check run becomes a row `evaluateGate` can read, with
 * `producer: 'ci'` — the value that has been in the enum since contract 03 was
 * written with nothing ever writing one.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const SHA = 'c'.repeat(40);
let root: string;

function stubFetch(body: unknown, status = 200): typeof globalThis.fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

const checkRuns = (over: Record<string, unknown> = {}): unknown => ({
  total_count: 1,
  check_runs: [
    {
      name: 'test',
      status: 'completed',
      conclusion: 'success',
      head_sha: SHA,
      html_url: 'https://github.com/o/r/runs/1',
      ...over,
    },
  ],
});

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ci-ev-')));
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('recording CI evidence', () => {
  it('writes a producer:ci row the gate can read', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'test',
      token: 'x',
      apply: true,
      fetcher: stubFetch(checkRuns()),
    });

    expect(result.admission.admitted).toBe(true);
    expect(result.evidenceId).toBeGreaterThan(0);

    const { db } = await openWorkspaceDatabase(root);
    try {
      const rows = await db.query<{ kind: string; producer: string; git_sha: string }>(
        'SELECT kind, producer, git_sha FROM evidence WHERE id = $1;',
        [result.evidenceId],
      );
      expect(rows[0]).toEqual({ kind: 'ci-status', producer: 'ci', git_sha: SHA });
    } finally {
      await db.close();
    }
  }, 180_000);

  it('writes nothing without --apply', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'test',
      token: 'x',
      fetcher: stubFetch(checkRuns()),
    });
    expect(result.envelope).toBeDefined();
    expect(result.evidenceId).toBeUndefined();
  }, 180_000);

  it('writes nothing at all when the check is still running', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'test',
      token: 'x',
      apply: true,
      fetcher: stubFetch(checkRuns({ status: 'in_progress', conclusion: null })),
    });
    expect(result.admission.refusal).toBe('not-finished');
    expect(result.evidenceId).toBeUndefined();
  }, 180_000);

  it('records a failing check as failing evidence rather than refusing', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'test',
      token: 'x',
      apply: true,
      fetcher: stubFetch(checkRuns({ conclusion: 'failure' })),
    });
    expect(result.evidenceId).toBeGreaterThan(0);
    expect(result.admission.payload?.ok).toBe(false);
  }, 180_000);

  it('lists the checks that are there when the named one is not', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'nope',
      token: 'x',
      fetcher: stubFetch(checkRuns({ name: 'lint' })),
    });
    expect(result.available).toEqual(['lint']);
    expect(result.admission.refusal).toBe('check-not-found');
  }, 180_000);
});

describe('the envelope', () => {
  it('binds to the sha the check ran on, not the ref that was asked about', () => {
    const other = 'd'.repeat(40);
    const envelope = ciEnvelope(
      admitCheckRun(
        [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: other }],
        'test',
      ),
    );
    // The branch moved after CI started. Binding to the requested ref would
    // make every envelope look current and defeat the staleness check.
    expect(envelope?.git_sha).toBe(other);
  });

  it('parses as a valid envelope, and carries ci confidence', () => {
    const envelope = ciEnvelope(
      admitCheckRun(
        [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: SHA }],
        'test',
      ),
    );
    expect(EvidenceEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope?.producer).toBe('ci');
    expect(envelope?.confidence).toBeGreaterThan(0);
  });

  it('is null for a refusal — there is nothing to write', () => {
    expect(ciEnvelope(admitCheckRun([], 'test'))).toBeNull();
  });
});

describe('reading the provider', () => {
  it('reports the page limit rather than silently truncating', async () => {
    const result = await ciEvidence(root, {
      repo: 'o/r',
      ref: SHA,
      check: 'test',
      token: 'x',
      fetcher: stubFetch({ ...(checkRuns() as object), total_count: 250 }),
    });
    expect(result.truncated).toBe(true);
  }, 180_000);

  it('throws with the provider status rather than treating an error as no checks', async () => {
    // The dangerous shape: a 404 that read as "no check runs" would be
    // indistinguishable from a repo whose CI never ran.
    await expect(
      fetchCheckRuns('o/r', SHA, 'x', stubFetch({ message: 'Not Found' }, 404)),
    ).rejects.toBeInstanceOf(CheckFetchError);
  });
});

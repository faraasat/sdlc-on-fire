import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { admit, AimdLimiter, CHECKPOINT_THRESHOLD, recordProviderLimits } from './admission.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * Admission control + AIMD backpressure (P1-SCHED-01).
 *
 * The budget half runs against a real database because the decision is only
 * meaningful against real stored state — a mocked budget tests the mock's idea
 * of what "85% consumed" means.
 */

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let root: string;
const at = new Date('2026-08-10T12:00:00.000Z');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sched-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);

  await port.setBudget({
    scope: 'agent',
    scopeId: 'agent-a',
    windowStart: new Date('2026-08-10T11:00:00.000Z'),
    windowEnd: new Date('2026-08-10T13:00:00.000Z'),
    limitTokens: 1_000,
  });
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('admission', () => {
  it('admits a run that fits comfortably', async () => {
    const decision = await admit(port, {
      scope: 'agent',
      scopeId: 'agent-a',
      estimatedTokens: 100,
      at,
    });
    expect(decision.verdict).toBe('admit');
  });

  it('denies a run that would exceed the limit, before anything is spent', async () => {
    // Checking after the fact turns a limit into a report.
    const decision = await admit(port, {
      scope: 'agent',
      scopeId: 'agent-a',
      estimatedTokens: 5_000,
      at,
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.reason).toMatch(/remain/);
  });

  it('tells a run to checkpoint at 85%, while there is still room to act', async () => {
    // Without this the only signal arrives at 100% — exactly when it is too
    // late to save anything.
    const decision = await admit(port, {
      scope: 'agent',
      scopeId: 'agent-a',
      estimatedTokens: 900,
      at,
    });
    expect(decision.verdict).toBe('checkpoint');
    expect(decision.usedFraction).toBeGreaterThanOrEqual(CHECKPOINT_THRESHOLD);
  });

  it('admits when no budget is configured, rather than blocking every workspace', async () => {
    // "No budget configured" and "no budget left" are different answers.
    const decision = await admit(port, {
      scope: 'agent',
      scopeId: 'nobody',
      estimatedTokens: 10_000,
      at,
    });
    expect(decision.verdict).toBe('admit');
    expect(decision.reason).toMatch(/no budget configured/);
  });

  it('accounts for tokens already spent', async () => {
    await port.chargeTokens({ scope: 'agent', scopeId: 'agent-a', tokens: 800, at });
    const decision = await admit(port, {
      scope: 'agent',
      scopeId: 'agent-a',
      estimatedTokens: 300,
      at,
    });
    expect(decision.verdict).toBe('deny');
  });
});

describe('AIMD backpressure', () => {
  it('increases additively on success', () => {
    const limiter = new AimdLimiter(2);
    expect(limiter.onSuccess()).toBe(3);
    expect(limiter.onSuccess()).toBe(4);
  });

  it('decreases multiplicatively on rejection', () => {
    // The asymmetry is the design: a provider that just refused us will not be
    // persuaded by trying almost as hard.
    const limiter = new AimdLimiter(8);
    expect(limiter.onRejection()).toBe(4);
    expect(limiter.onRejection()).toBe(2);
  });

  it('never drops below the floor, so one bad minute cannot stall the daemon', () => {
    const limiter = new AimdLimiter(2, { floor: 1 });
    for (let i = 0; i < 10; i += 1) limiter.onRejection();
    expect(limiter.limit).toBe(1);
  });

  it('respects the ADR-0029 ceiling however well things go', () => {
    const limiter = new AimdLimiter(1, { ceiling: 8 });
    for (let i = 0; i < 50; i += 1) limiter.onSuccess();
    expect(limiter.limit).toBe(8);
  });

  it('recovers slowly after a rejection rather than climbing back into the wall', () => {
    const limiter = new AimdLimiter(8);
    limiter.onRejection();
    limiter.onSuccess();
    expect(limiter.limit).toBe(5);
  });
});

describe('provider limits', () => {
  it('stores what the provider reported, and updates in place', async () => {
    await recordProviderLimits(db, {
      provider: 'anthropic',
      requestsRemaining: 42,
      retryAfterMs: 1_000,
    });
    await recordProviderLimits(db, { provider: 'anthropic', requestsRemaining: 7 });

    const rows = await db.query<{ requests_remaining: number; provider: string }>(
      "SELECT provider, requests_remaining FROM provider_rate_limits WHERE provider = 'anthropic';",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requests_remaining).toBe(7);
  });
});

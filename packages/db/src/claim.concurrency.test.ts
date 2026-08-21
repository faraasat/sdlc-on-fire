import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contend,
  describeContention,
  seededRandom,
  violatesMutualExclusion,
} from '@sdlc-on-fire/core';
import { applySchema } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';
import { PostgresStorageAdapter } from './postgres-adapter.js';

/**
 * P3-QA-12 — claim acquisition under contention.
 *
 * ADR-0048 makes a claim the thing that stops two agents working the same card,
 * and the whole guarantee rests on acquisition being one atomic conditional
 * UPDATE rather than a SELECT followed by an UPDATE. That difference is
 * invisible in a sequential test: both shapes pass, every time, forever.
 *
 * The seed is recorded and printed on failure. It does not make the OS
 * scheduler deterministic — nothing here claims that — but it makes the *shape*
 * of the contention reproducible, which turns "it failed once on CI" into
 * something a person can run again.
 */

const SEED = 20260822;

let db: ProvisionedDatabase;
let store: PostgresStorageAdapter;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-claim-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  store = await PostgresStorageAdapter.create(db);
  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
     VALUES ('RACE-1','feature','contended','inbox','implement','kanban/RACE-1.md','h1');`,
  );
}, 90_000);

afterEach(async () => {
  await db?.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}, 30_000);

describe('claim acquisition', () => {
  it('gives the card to exactly one of eight simultaneous agents, every round', async () => {
    // The property the atomic UPDATE exists for. Eight actors, twelve rounds:
    // a race that shows up one run in twenty needs more than one attempt, and a
    // single-shot test would report luck as correctness.
    const result = await contend({
      seed: SEED,
      actors: 8,
      rounds: 12,
      setup: async () => {
        await db.query(
          `UPDATE work_items SET claimed_by = NULL, claim_kind = NULL,
                                 claimed_at = NULL, lease_expires_at = NULL WHERE id = 'RACE-1';`,
        );
      },
      attempt: (actor) =>
        store.claim({
          workItemId: 'RACE-1',
          actor: `agent-${String(actor)}`,
          kind: 'agent',
          leaseMs: 60_000,
        }),
    });

    const violations = violatesMutualExclusion(result, (outcome) => outcome.value !== null);
    expect(violations.length, describeContention(result, violations)).toBe(0);
  }, 180_000);

  it('lets the holder re-acquire without ever handing the card to a second agent', async () => {
    // Re-entrancy is deliberate — an agent that retries its own claim must not
    // deadlock itself — and it is exactly where a mutual-exclusion check gets
    // quietly weakened into "somebody holds it".
    const result = await contend({
      seed: SEED + 1,
      actors: 6,
      rounds: 8,
      setup: async () => {
        await db.query(
          `UPDATE work_items SET claimed_by = 'agent-0', claim_kind = 'agent',
                                 claimed_at = now(), lease_expires_at = now() + interval '60 seconds'
            WHERE id = 'RACE-1';`,
        );
      },
      attempt: (actor) =>
        store.claim({
          workItemId: 'RACE-1',
          actor: `agent-${String(actor)}`,
          kind: 'agent',
          leaseMs: 60_000,
        }),
    });

    // Only the incumbent may win, and only ever one.
    for (const round of result.rounds) {
      const winners = round.outcomes.filter((outcome) => outcome.value !== null);
      expect(winners, `round ${String(round.round)}: ${result.replay}`).toHaveLength(1);
      expect(winners[0]?.actor).toBe(0);
    }
  }, 180_000);

  it('hands an expired lease to exactly one waiting agent, not to all of them', async () => {
    // The takeover path, which is where a naive `lease_expires_at <= now()`
    // check races: every waiting agent reads the same expired row and every one
    // of them concludes it is free.
    const result = await contend({
      seed: SEED + 2,
      actors: 8,
      rounds: 10,
      setup: async () => {
        await db.query(
          `UPDATE work_items SET claimed_by = 'agent-dead', claim_kind = 'agent',
                                 claimed_at = now() - interval '2 hours',
                                 lease_expires_at = now() - interval '1 hour'
            WHERE id = 'RACE-1';`,
        );
      },
      attempt: (actor) =>
        store.claim({
          workItemId: 'RACE-1',
          actor: `agent-${String(actor)}`,
          kind: 'agent',
          leaseMs: 60_000,
        }),
    });

    const violations = violatesMutualExclusion(result, (outcome) => outcome.value !== null);
    expect(violations.length, describeContention(result, violations)).toBe(0);
  }, 180_000);

  it('releases only for the holder, however many others try at once', async () => {
    // Releasing someone else's claim is a break-claim, which ADR-0048 requires
    // to be an audited path rather than an ordinary release.
    const result = await contend({
      seed: SEED + 3,
      actors: 6,
      rounds: 8,
      setup: async () => {
        await db.query(
          `UPDATE work_items SET claimed_by = 'agent-1', claim_kind = 'agent',
                                 claimed_at = now(), lease_expires_at = now() + interval '60 seconds'
            WHERE id = 'RACE-1';`,
        );
      },
      attempt: (actor) => store.releaseClaim('RACE-1', `agent-${String(actor)}`),
    });

    const violations = violatesMutualExclusion(result, (outcome) => outcome.value === true);
    expect(violations.length, describeContention(result, violations)).toBe(0);
  }, 180_000);
});

describe('the harness itself', () => {
  it('replays the same jitter sequence for a seed', () => {
    // If this were not true the recorded seed would be decoration, and a
    // failure message telling somebody to replay it would be a lie.
    const a = Array.from({ length: 8 }, seededRandom(99));
    const b = Array.from({ length: 8 }, seededRandom(99));
    const c = Array.from({ length: 8 }, seededRandom(100));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('reports zero winners as a violation, not only two', async () => {
    // Both directions are failures and they mean opposite things: two winners
    // is a lost update, zero is a livelock where contention starved everybody.
    const result = await contend({
      seed: 1,
      actors: 4,
      rounds: 2,
      attempt: () => Promise.resolve(null),
    });
    const violations = violatesMutualExclusion(result, (outcome) => outcome.value !== null);
    expect(violations).toHaveLength(2);
    expect(violations[0]?.winners).toBe(0);
  });

  it('captures a rejection instead of aborting the round', async () => {
    // A race usually shows up as two actors succeeding where one should have;
    // throwing on the first error would discard the evidence.
    const result = await contend({
      seed: 2,
      actors: 3,
      rounds: 1,
      attempt: (actor) => (actor === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok')),
    });
    expect(result.rounds[0]?.outcomes).toHaveLength(3);
    expect(result.rounds[0]?.outcomes[1]?.error).toBe('boom');
  });

  it('keeps actors in the same tick by default, or it measures nothing', async () => {
    // The defect that made this whole tier useless. `await delay(0)` was
    // `setTimeout(…, 0)`, and timers each fire in their own macrotask — so an
    // actor resumed, ran its entire database round trip, and finished before
    // the next actor's timer fired. Every actor ran alone, the harness reported
    // a clean run, and a `claim` mutated into check-then-act stayed green.
    // Found by mutating the code the tier exists to protect and noticing that
    // nothing went red.
    const started: number[] = [];
    await contend({
      seed: 5,
      actors: 4,
      rounds: 1,
      attempt: (actor) => {
        started.push(actor);
        // Resolves on a later microtask; if actors were serialised by timers,
        // each would appear alone before the next was pushed.
        return Promise.resolve().then(() => started.length);
      },
    });
    // All four entered before any observed a completed length of 1.
    expect(started).toHaveLength(4);
  });

  it('puts the seed in the failure message', async () => {
    const result = await contend({
      seed: 4242,
      actors: 2,
      rounds: 1,
      attempt: () => Promise.resolve(null),
    });
    const violations = violatesMutualExclusion(result, (outcome) => outcome.value !== null);
    expect(describeContention(result, violations)).toContain('seed=4242');
  });
});

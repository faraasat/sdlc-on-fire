import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { init } from './commands.js';

/**
 * `init` and the database, told apart (real-world testing, 2026-08-23).
 *
 * Pointing the published package at real repositories found `sdlc init`
 * exiting 0 while printing that the database had not started. A script doing
 * `sdlc init && sdlc verify …` sails straight past a workspace with no mirror.
 *
 * But the two situations that reached that branch are not the same, and
 * failing both would be worse than failing neither:
 *
 *   * **held** — somebody already has `sdlc serve` running. PGlite is
 *     single-connection, so ours cannot open it. Nothing is wrong. This is the
 *     most ordinary setup there is and must stay exit 0.
 *   * **failed** — bad permissions, corrupt data directory, a WASM runtime
 *     that will not start. The scaffold exists and the mirror does not.
 */
describe('init reports the database honestly', () => {
  it('is ready on a clean workspace, and not "held"', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-initdb-'));
    try {
      const result = await init(root);
      expect(result.database.ready).toBe(true);
      expect(result.database.held).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('distinguishes a held database from a failed one', async () => {
    // Two inits over the same root in parallel: one wins the lock.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-initrace-'));
    try {
      const [a, b] = await Promise.all([init(root), init(root)]);
      const outcomes = [a, b];
      const ready = outcomes.filter((r) => r.database.ready);
      const held = outcomes.filter((r) => r.database.held === true);

      // Exactly one may hold it; whoever missed must say *held*, never "did
      // not start", because the database plainly did start — for the other one.
      expect(ready.length + held.length).toBe(2);
      for (const outcome of held) {
        // `held` is the flag callers branch on; `detail` carries PGlite's own
        // words. What must never happen is describing a database that plainly
        // *did* start — for the other process — as one that did not.
        expect(outcome.database.detail).not.toContain('did not start');
        expect(outcome.database.detail).toContain('already owned by another process');
        expect(outcome.database.ready).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('never reports both ready and held', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-initboth-'));
    try {
      const result = await init(root);
      expect(result.database.ready && result.database.held === true).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});

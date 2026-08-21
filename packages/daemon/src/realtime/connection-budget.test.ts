import { describe, expect, it } from 'vitest';
import {
  admitDaemon,
  connectionsPerDaemon,
  countDaemonConnections,
  DEFAULT_FOOTPRINT,
  formatBudget,
  readMaxConnections,
  RESERVED_CONNECTIONS,
} from './connection-budget.js';

/**
 * P3-META-01 — the connection budget.
 *
 * One daemon per developer against a shared Postgres, and the wall is
 * `max_connections` rather than CPU. `LISTEN` is a session that stays open for
 * the daemon's whole life, so it cannot share a pool — which makes the budget
 * both real and invisible until the last person to start a daemon is refused.
 */

describe('connectionsPerDaemon', () => {
  it('counts the dedicated LISTEN session on top of the pool', () => {
    // The LISTEN connection is never returned to a pool. Counting only the pool
    // under-reports every daemon by exactly one, which is the error that puts
    // the wall closer than the dashboard says.
    expect(connectionsPerDaemon()).toBe(DEFAULT_FOOTPRINT.listen + DEFAULT_FOOTPRINT.poolMax);
    expect(connectionsPerDaemon({ listen: 1, poolMax: 9 })).toBe(10);
  });
});

describe('admitDaemon', () => {
  it('computes capacity from the usable connections, not the raw maximum', () => {
    // Postgres reserves connections for superusers. Counting them as headroom
    // puts the wall three connections early and refuses the last developer
    // while the dashboard still shows capacity.
    const verdict = admitDaemon({ maxConnections: 100, currentDaemons: 0 });
    expect(verdict.usable).toBe(100 - RESERVED_CONNECTIONS);
    expect(verdict.capacity).toBe(Math.floor((100 - RESERVED_CONNECTIONS) / 5));
  });

  it('admits while there is room', () => {
    const verdict = admitDaemon({ maxConnections: 100, currentDaemons: 3 });
    expect(verdict.admitted).toBe(true);
    expect(verdict.because).toContain('more daemon(s) fit');
  });

  it('refuses before Postgres would, and says it is a shared budget', () => {
    // "too many clients already" reads as a broken install to whoever hits it
    // and says nothing about a budget shared with colleagues.
    const verdict = admitDaemon({ maxConnections: 20, currentDaemons: 3 });
    expect(verdict.admitted).toBe(false);
    expect(verdict.because).toContain('already running');
    expect(verdict.because).toMatch(/raise max_connections|pooler|stop a daemon/i);
  });

  it('refuses at the boundary rather than one past it', () => {
    const capacity = admitDaemon({ maxConnections: 28, currentDaemons: 0 }).capacity;
    expect(admitDaemon({ maxConnections: 28, currentDaemons: capacity - 1 }).admitted).toBe(true);
    expect(admitDaemon({ maxConnections: 28, currentDaemons: capacity }).admitted).toBe(false);
  });

  it('scales with a larger pool', () => {
    const small = admitDaemon({
      maxConnections: 100,
      currentDaemons: 0,
      footprint: { listen: 1, poolMax: 1 },
    });
    const large = admitDaemon({
      maxConnections: 100,
      currentDaemons: 0,
      footprint: { listen: 1, poolMax: 19 },
    });
    expect(small.capacity).toBeGreaterThan(large.capacity);
  });

  it('treats a negative daemon count as zero rather than inventing headroom', () => {
    expect(admitDaemon({ maxConnections: 100, currentDaemons: -5 }).current).toBe(0);
  });
});

describe('readMaxConnections', () => {
  it('asks the server rather than assuming the default', () => {
    // max_connections is routinely raised in production and lowered on small
    // managed instances; a budget computed from a guessed 100 is wrong in both
    // directions.
    const db = { query: <T>() => Promise.resolve([{ setting: '250' }] as T[]) };
    return expect(readMaxConnections(db)).resolves.toBe(250);
  });

  it('returns null — not zero — where the setting does not exist', () => {
    // PGlite is a single embedded process with no shared budget. Null means
    // "not applicable"; zero would mean "no capacity" and refuse every daemon.
    const db = { query: <T>() => Promise.reject<T[]>(new Error('no such setting')) };
    return expect(readMaxConnections(db)).resolves.toBeNull();
  });

  it('returns null for an unparseable answer', () => {
    const db = { query: <T>() => Promise.resolve([{ setting: 'lots' }] as T[]) };
    return expect(readMaxConnections(db)).resolves.toBeNull();
  });
});

describe('countDaemonConnections', () => {
  it('counts distinct daemons from pg_stat_activity', () => {
    const db = { query: <T>() => Promise.resolve([{ count: '7' }] as T[]) };
    return expect(countDaemonConnections(db)).resolves.toBe(7);
  });

  it('returns null where the view is unavailable', () => {
    const db = { query: <T>() => Promise.reject<T[]>(new Error('permission denied')) };
    return expect(countDaemonConnections(db)).resolves.toBeNull();
  });
});

describe('formatBudget', () => {
  it('shows the arithmetic, not just the verdict', () => {
    // Somebody told "no room" needs to see where the number came from to know
    // whether to raise max_connections or shrink a pool.
    const text = formatBudget(admitDaemon({ maxConnections: 100, currentDaemons: 1 }));
    expect(text).toContain('max_connections');
    expect(text).toContain('reserved');
    expect(text).toContain('dedicated LISTEN');
  });
});

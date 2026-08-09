import { describe, expect, it } from 'vitest';
import { SelfWriteRegistry } from './self-write-registry.js';

/** Injectable clock — a TTL test that sleeps is a slow flaky test. */
function fixedClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe('self-write claims', () => {
  it('claims a recorded write exactly once', () => {
    const registry = new SelfWriteRegistry();
    registry.record('kanban/a.md', 'h1');

    expect(registry.claim('kanban/a.md', 'h1')).toBe(true);
    // A second event with the same hash is a genuine external rewrite, not the
    // same write echoing twice — it must not be swallowed by a stale claim.
    expect(registry.claim('kanban/a.md', 'h1')).toBe(false);
  });

  it('does not claim a different hash on the same path', () => {
    const registry = new SelfWriteRegistry();
    registry.record('kanban/a.md', 'h1');
    expect(registry.claim('kanban/a.md', 'h2')).toBe(false);
  });

  it('does not claim the same hash on a different path', () => {
    const registry = new SelfWriteRegistry();
    registry.record('kanban/a.md', 'h1');
    expect(registry.claim('kanban/b.md', 'h1')).toBe(false);
  });

  it('treats an unrecorded write as external', () => {
    // The safe direction to be wrong in: re-processing an unchanged file wastes
    // an upsert, dropping a real edit is silent data loss.
    expect(new SelfWriteRegistry().claim('kanban/a.md', 'h1')).toBe(false);
  });
});

describe('TTL', () => {
  it('expires a claim that was never consumed', () => {
    const clock = fixedClock();
    const registry = new SelfWriteRegistry({ ttlMs: 100, now: clock.now });
    registry.record('kanban/a.md', 'h1');

    clock.advance(101);
    expect(registry.claim('kanban/a.md', 'h1')).toBe(false);
  });

  it('honours a claim still inside the window', () => {
    const clock = fixedClock();
    const registry = new SelfWriteRegistry({ ttlMs: 100, now: clock.now });
    registry.record('kanban/a.md', 'h1');

    clock.advance(99);
    expect(registry.claim('kanban/a.md', 'h1')).toBe(true);
  });

  it('drops expired entries from the reported size', () => {
    const clock = fixedClock();
    const registry = new SelfWriteRegistry({ ttlMs: 100, now: clock.now });
    registry.record('kanban/a.md', 'h1');
    expect(registry.size).toBe(1);

    clock.advance(101);
    expect(registry.size).toBe(0);
  });
});

describe('multiple in-flight writes', () => {
  it('tracks several hashes for one path independently', () => {
    // An agent rewriting the same file twice in quick succession.
    const registry = new SelfWriteRegistry();
    registry.record('kanban/a.md', 'h1');
    registry.record('kanban/a.md', 'h2');

    expect(registry.claim('kanban/a.md', 'h2')).toBe(true);
    expect(registry.claim('kanban/a.md', 'h1')).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('clears everything on demand', () => {
    const registry = new SelfWriteRegistry();
    registry.record('a', 'h');
    registry.clear();
    expect(registry.size).toBe(0);
  });
});

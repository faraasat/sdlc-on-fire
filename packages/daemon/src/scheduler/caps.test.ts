import { describe, expect, it } from 'vitest';
import {
  CapExceededError,
  ConcurrencyGovernor,
  MAX_CONCURRENCY,
  MAX_RECURSION_DEPTH,
  MAX_WAVE_COUNT,
  planWave,
} from './caps.js';

/**
 * Subagent caps (P1-SCHED-03, ADR-0029).
 *
 * Every assertion here is about refusing rather than truncating. A wave that
 * quietly dropped its ninth task produces a partial result indistinguishable
 * from a complete one, and the caller acts on it as though everything ran.
 */

const wave = { waveId: 'w1', taskCount: 4, depth: 0 };

describe('planning a wave', () => {
  it('accepts a wave within every cap', () => {
    expect(planWave(wave).concurrency).toBeLessThanOrEqual(MAX_CONCURRENCY);
  });

  it('never runs more workers than there is work', () => {
    expect(planWave({ ...wave, taskCount: 2 }).concurrency).toBe(2);
  });

  it('refuses a wave beyond the count ceiling', () => {
    // Eight at a time and five hundred in sequence is still five hundred.
    expect(() => planWave({ ...wave, taskCount: MAX_WAVE_COUNT + 1 })).toThrow(CapExceededError);
  });

  it('refuses concurrency above the cap rather than clamping it', () => {
    // Clamping would let a caller ask for 50 and believe it got 50.
    expect(() => planWave({ ...wave, concurrency: MAX_CONCURRENCY + 1 })).toThrow(/ADR-0029/);
  });

  it('refuses recursion beyond depth 2, naming why', () => {
    // The one that turns a bug into a bill: growth is exponential and nothing
    // downstream bounds it.
    expect(() => planWave({ ...wave, depth: MAX_RECURSION_DEPTH + 1 })).toThrow(/exponentially/);
  });

  it('allows a subagent-spawned wave at the boundary', () => {
    expect(planWave({ ...wave, depth: MAX_RECURSION_DEPTH }).depth).toBe(MAX_RECURSION_DEPTH);
  });

  it('rejects before anything runs, not partway through', () => {
    // Half a wave is worse than none: its output looks whole.
    expect(() => planWave({ ...wave, taskCount: 1_000 })).toThrow(CapExceededError);
  });
});

describe('the concurrency governor', () => {
  it('admits up to its limit and then refuses', () => {
    const governor = new ConcurrencyGovernor(2);
    expect(governor.tryAcquire()).toBe(true);
    expect(governor.tryAcquire()).toBe(true);
    expect(governor.tryAcquire()).toBe(false);
  });

  it('frees a slot on release', () => {
    const governor = new ConcurrencyGovernor(1);
    governor.tryAcquire();
    governor.release();
    expect(governor.tryAcquire()).toBe(true);
  });

  it('cannot be configured above the hard cap', () => {
    expect(() => new ConcurrencyGovernor(MAX_CONCURRENCY + 1)).toThrow(CapExceededError);
  });

  it('clamps an unbalanced release at zero', () => {
    // A negative counter quietly raises the effective cap — a leak that makes
    // the limit look enforced while it is not.
    const governor = new ConcurrencyGovernor(2);
    governor.release();
    governor.release();
    expect(governor.active).toBe(0);
    governor.tryAcquire();
    governor.tryAcquire();
    expect(governor.tryAcquire()).toBe(false);
  });
});

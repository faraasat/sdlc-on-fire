import { describe, expect, it } from 'vitest';
import { idempotencyKey, isSideEffecting, SIDE_EFFECTING_ACTIONS } from './idempotency.js';

/**
 * Idempotency keys (P1-AGENT-04).
 *
 * The failure being prevented is specific: a run dies after opening a pull
 * request but before recording that it did, and the resume opens a second one.
 * Everything here is about whether a retry produces the *same* key.
 */

const base = {
  workItemId: 'FEAT-001',
  stage: 'review',
  action: 'pr_create' as const,
  input: { branch: 'feat/csv-export', base: 'main' },
};

describe('a retry produces the same key', () => {
  it('is stable across calls', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey(base));
  });

  it('ignores key order in the input', () => {
    // Two attempts assembling the same object differently must still match, or
    // the ledger never recognises the retry.
    const reordered = { ...base, input: { base: 'main', branch: 'feat/csv-export' } };
    expect(idempotencyKey(reordered)).toBe(idempotencyKey(base));
  });

  it('ignores fields nobody passed', () => {
    const withUndefined = { ...base, input: { ...base.input, note: undefined } };
    expect(idempotencyKey(withUndefined)).toBe(idempotencyKey(base));
  });
});

describe('a different action produces a different key', () => {
  it('separates actions on the same work item', () => {
    expect(idempotencyKey({ ...base, action: 'pr_comment' })).not.toBe(idempotencyKey(base));
  });

  it('separates the same action on different work items', () => {
    expect(idempotencyKey({ ...base, workItemId: 'FEAT-002' })).not.toBe(idempotencyKey(base));
  });

  it('separates the same action at different stages', () => {
    expect(idempotencyKey({ ...base, stage: 'done' })).not.toBe(idempotencyKey(base));
  });

  it('separates a genuinely different input', () => {
    const other = { ...base, input: { branch: 'feat/other', base: 'main' } };
    expect(idempotencyKey(other)).not.toBe(idempotencyKey(base));
  });
});

describe('what must never enter the key', () => {
  it('is unaffected by anything that varies per attempt', () => {
    // A timestamp, attempt counter or run id in the key guarantees every retry
    // is a fresh key — the ledger fills up and never prevents a duplicate. This
    // pins the derivation to the four declared fields.
    const noisy = {
      ...base,
      // These are not part of ActionIdentity; passing them must change nothing.
      attempt: 3,
      runId: 'run-abc',
      now: new Date().toISOString(),
    } as unknown as typeof base;
    expect(idempotencyKey(noisy)).toBe(idempotencyKey(base));
  });
});

describe('which actions need protection', () => {
  it('recognises the declared set', () => {
    for (const action of SIDE_EFFECTING_ACTIONS) {
      expect(isSideEffecting(action), action).toBe(true);
    }
  });

  it('does not treat an internal action as side-effecting', () => {
    // Ledger protection has a cost; applying it to a DB write nobody outside
    // can see would be ceremony.
    expect(isSideEffecting('mirror_upsert')).toBe(false);
  });
});

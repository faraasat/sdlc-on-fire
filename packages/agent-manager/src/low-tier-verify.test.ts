import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_CROSS_CHECK_RATE,
  inCrossCheckSample,
  LOW_TIER_VERIFICATION,
  verifyLowTierOutput,
} from './low-tier-verify.js';

/**
 * P1-GATE-05 — the gate on cheap-tier output (ADR-0028 §4).
 *
 * The property being defended is that "verifiable" is a fact about the task
 * type, not a promise the caller makes. Every test here is some version of
 * "cheap output does not become trusted by being well-formed".
 */

const Extraction = z.object({ id: z.string().min(1), score: z.number() }).strict();

describe('eligibility', () => {
  it('refuses a low-tier task with no declared verification', async () => {
    const verdict = await verifyLowTierOutput({
      tier: 'low',
      taskType: 'architecture-decision',
      output: { anything: true },
    });
    // Adding a cheap route means writing down how its output is checked, in the
    // same edit — or the route does not exist.
    expect(verdict.trusted).toBe(false);
    expect(verdict.problems[0]).toContain('not low-tier');
  });

  it('leaves medium and high tiers to their own gates', async () => {
    const verdict = await verifyLowTierOutput({
      tier: 'medium',
      taskType: 'architecture-decision',
      output: {},
    });
    expect(verdict.trusted).toBe(true);
    expect(verdict.method).toBe('not-low-tier');
  });

  it('declares a verification for every low-tier row in the policy table', () => {
    for (const [taskType, method] of Object.entries(LOW_TIER_VERIFICATION)) {
      expect(['schema', 'rubric', 'cross-check']).toContain(method);
      expect(taskType.length).toBeGreaterThan(0);
    }
  });
});

describe('schema verification', () => {
  const base = { tier: 'low' as const, taskType: 'extraction', schema: Extraction };

  it('trusts output that validates', async () => {
    const verdict = await verifyLowTierOutput({ ...base, output: { id: 'a', score: 1 } });
    expect(verdict.trusted).toBe(true);
    expect(verdict.output).toEqual({ id: 'a', score: 1 });
  });

  it('refuses when the schema itself was never supplied', async () => {
    const verdict = await verifyLowTierOutput({ tier: 'low', taskType: 'extraction', output: {} });
    // The verification is the reason this was allowed to run cheap.
    expect(verdict.trusted).toBe(false);
    expect(verdict.problems[0]).toContain('no schema was supplied');
  });

  it('refuses malformed output with the offending path', async () => {
    const verdict = await verifyLowTierOutput({ ...base, output: { id: 'a', score: 'high' } });
    expect(verdict.trusted).toBe(false);
    expect(verdict.problems.join(' ')).toContain('score');
  });

  it('takes exactly one repair attempt', async () => {
    let attempts = 0;
    const verdict = await verifyLowTierOutput({
      ...base,
      output: { id: 'a', score: 'high' },
      repair: () => {
        attempts += 1;
        return Promise.resolve({ id: 'a', score: 3 });
      },
    });
    expect(verdict.trusted).toBe(true);
    expect(verdict.repaired).toBe(true);
    expect(attempts).toBe(1);
  });

  it('does not loop when the repair also fails', async () => {
    let attempts = 0;
    const verdict = await verifyLowTierOutput({
      ...base,
      output: { id: 'a', score: 'high' },
      repair: () => {
        attempts += 1;
        return Promise.resolve({ id: 'a', score: 'still wrong' });
      },
    });
    // A model that cannot produce the shape twice will not produce it on the
    // fifth try, and the loop would spend the saving it was meant to protect.
    expect(attempts).toBe(1);
    expect(verdict.trusted).toBe(false);
    expect(verdict.problems.at(-1)).toContain('repair pass still did not');
  });
});

describe('rubric verification', () => {
  const base = { tier: 'low' as const, taskType: 'formatting' };

  it('trusts output the rubric accepts', async () => {
    const verdict = await verifyLowTierOutput({ ...base, output: 'ok', rubric: () => [] });
    expect(verdict.trusted).toBe(true);
    expect(verdict.method).toBe('rubric');
  });

  it('refuses with the rubric findings', async () => {
    const verdict = await verifyLowTierOutput({
      ...base,
      output: 'nope',
      rubric: () => ['trailing whitespace', 'tabs mixed with spaces'],
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.problems).toHaveLength(2);
  });

  it('refuses when no rubric was supplied', async () => {
    const verdict = await verifyLowTierOutput({ ...base, output: 'ok' });
    expect(verdict.trusted).toBe(false);
  });
});

describe('cross-check sampling', () => {
  it('is deterministic for the same output', () => {
    const first = inCrossCheckSample({ a: 1 }, 0.5);
    for (let i = 0; i < 5; i += 1) expect(inCrossCheckSample({ a: 1 }, 0.5)).toBe(first);
  });

  it('samples roughly the configured share', () => {
    const outputs = Array.from({ length: 400 }, (_, i) => ({ n: i }));
    const sampled = outputs.filter((output) => inCrossCheckSample(output, 0.25)).length;
    expect(sampled).toBeGreaterThan(60);
    expect(sampled).toBeLessThan(140);
  });

  it('never samples at a rate of zero and always samples at one', () => {
    expect(inCrossCheckSample({ a: 1 }, 0)).toBe(false);
    expect(inCrossCheckSample({ a: 1 }, 1)).toBe(true);
  });

  it('has a default rate that is a sample, not a universal check', () => {
    // Cross-checking everything would spend the tiering saving it exists to protect.
    expect(DEFAULT_CROSS_CHECK_RATE).toBeGreaterThan(0);
    expect(DEFAULT_CROSS_CHECK_RATE).toBeLessThan(1);
  });
});

describe('cross-check verification', () => {
  // No shipped row uses `cross-check` yet; a workspace registers its own. It is
  // still a table, so the eligibility invariant holds.
  const base = {
    tier: 'low' as const,
    taskType: 'summarise',
    table: { summarise: 'cross-check' as const },
    crossCheckRate: 1,
  };

  it('reports honestly that an unsampled result was never checked', async () => {
    let called = 0;
    const verdict = await verifyLowTierOutput({
      ...base,
      crossCheckRate: 0,
      output: { finding: 'x' },
      crossCheck: () => {
        called += 1;
        return Promise.resolve({ agrees: true, note: '' });
      },
    });
    expect(verdict.trusted).toBe(true);
    // Trusted, and it says the check did not run — reporting "verified" for
    // unsampled work would describe a check that never happened.
    expect(verdict.crossChecked).toBe(false);
    expect(called).toBe(0);
  });

  it('refuses when the higher tier disagrees', async () => {
    const verdict = await verifyLowTierOutput({
      ...base,
      output: { finding: 'x' },
      crossCheck: () => Promise.resolve({ agrees: false, note: 'the rule does not apply here' }),
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict.crossChecked).toBe(true);
    expect(verdict.problems[0]).toContain('does not apply');
  });
});

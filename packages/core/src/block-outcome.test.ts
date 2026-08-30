import { describe, expect, it } from 'vitest';
import {
  admitBlockOutcome,
  BLOCK_OUTCOMES,
  latestTags,
  TAG_REFUSALS,
  type BlockOutcomeTag,
} from './block-outcome.js';
import type { Actor } from './capability.js';

/**
 * The adoption bar's admission rules (P8-BAR-01, ADR-0063).
 *
 * These are the rules that decide what the product's primary success metric is
 * made of, so each one is tested against the specific way it would be wrong
 * rather than against the happy path.
 */

const human: Actor = { id: 'a-1', kind: 'human', displayName: 'Dana' };
const agent: Actor = { id: 'a-2', kind: 'agent', displayName: 'implementer' };
const now = new Date('2026-09-01T10:00:00.000Z');

describe('admitBlockOutcome', () => {
  it('records a human judging a block', () => {
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'fail',
      actor: human,
      outcome: 'valuable',
      reason: 'caught a missing migration',
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tag).toEqual({
      gateId: 7,
      actorId: 'a-1',
      outcome: 'valuable',
      reason: 'caught a missing migration',
      taggedAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('refuses an agent — it may not rate its own block valuable', () => {
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'fail',
      actor: agent,
      outcome: 'valuable',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'agent-actor' });
  });

  it('refuses an agent even for `nuisance` — the direction is not the point', () => {
    // The tempting narrow rule is "an agent must not call its own block
    // valuable". That leaves the metric just as corruptible from the other
    // side: an agent tagging every block a nuisance drives the friction counter
    // that decides whether the gates get loosened.
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'fail',
      actor: agent,
      outcome: 'nuisance',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'agent-actor' });
  });

  it('refuses a gate that passed — it stopped nobody', () => {
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'pass',
      actor: human,
      outcome: 'valuable',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'gate-not-a-block' });
  });

  it('distinguishes a pending gate from a passing one', () => {
    // Both are "not a block", and collapsing them would tell somebody who
    // tagged too early that their gate passed, which is a different and wrong
    // fact about their work.
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'pending',
      actor: human,
      outcome: 'valuable',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'gate-unresolved' });
  });

  it('refuses an outcome outside the vocabulary', () => {
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'fail',
      actor: human,
      outcome: 'meh',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'unknown-outcome' });
    if (result.ok) return;
    // The message has to name what was allowed, or the next thing the user
    // types is another guess.
    expect(result.because).toContain('valuable');
    expect(result.because).toContain('nuisance');
  });

  it('normalises an empty or blank reason to null', () => {
    for (const reason of [undefined, null, '', '   ', '\n\t']) {
      const result = admitBlockOutcome({
        gateId: 1,
        gateResult: 'fail',
        actor: human,
        outcome: 'nuisance',
        reason,
        now,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.tag.reason).toBeNull();
    }
  });

  it('trims a reason rather than storing the whitespace', () => {
    const result = admitBlockOutcome({
      gateId: 1,
      gateResult: 'fail',
      actor: human,
      outcome: 'nuisance',
      reason: '  blocked on a lockfile churn  ',
      now,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tag.reason).toBe('blocked on a lockfile churn');
  });

  it('checks the actor before the gate result', () => {
    // Ordering matters for the message a user sees: an agent tagging a passing
    // gate has two problems and the one worth naming is that it may not tag at
    // all. Reporting `gate-not-a-block` would imply that fixing the gate would
    // let it through.
    const result = admitBlockOutcome({
      gateId: 7,
      gateResult: 'pass',
      actor: agent,
      outcome: 'valuable',
      now,
    });
    expect(result).toMatchObject({ ok: false, refusal: 'agent-actor' });
  });

  it('every refusal it can return is in the declared vocabulary', () => {
    const seen = new Set<string>();
    for (const input of [
      { gateResult: 'fail' as const, actor: human, outcome: 'nope' },
      { gateResult: 'fail' as const, actor: agent, outcome: 'valuable' },
      { gateResult: 'pending' as const, actor: human, outcome: 'valuable' },
      { gateResult: 'pass' as const, actor: human, outcome: 'valuable' },
    ]) {
      const result = admitBlockOutcome({ gateId: 1, now, ...input });
      if (!result.ok) seen.add(result.refusal);
    }
    expect([...seen].sort()).toEqual([...TAG_REFUSALS].sort());
  });

  it('has exactly two outcomes', () => {
    // A third ("neutral", "unsure") would be the one everybody picks, and a
    // metric where the modal answer is an abstention measures nothing.
    expect(BLOCK_OUTCOMES).toEqual(['valuable', 'nuisance']);
  });
});

describe('latestTags', () => {
  const tag = (
    gateId: number,
    actorId: string,
    outcome: 'valuable' | 'nuisance',
    taggedAt: string,
  ): BlockOutcomeTag => ({ gateId, actorId, outcome, reason: null, taggedAt });

  it('keeps the most recent tag per actor per gate', () => {
    const result = latestTags([
      tag(1, 'a', 'nuisance', '2026-09-01T10:00:00.000Z'),
      tag(1, 'a', 'valuable', '2026-09-03T10:00:00.000Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe('valuable');
  });

  it('does not let one actor overwrite another on the same gate', () => {
    const result = latestTags([
      tag(1, 'a', 'nuisance', '2026-09-01T10:00:00.000Z'),
      tag(1, 'b', 'valuable', '2026-09-02T10:00:00.000Z'),
    ]);
    expect(result).toHaveLength(2);
  });

  it('does not let one gate overwrite another for the same actor', () => {
    const result = latestTags([
      tag(1, 'a', 'nuisance', '2026-09-01T10:00:00.000Z'),
      tag(2, 'a', 'valuable', '2026-09-02T10:00:00.000Z'),
    ]);
    expect(result).toHaveLength(2);
  });

  it('ignores an out-of-order earlier tag arriving last', () => {
    // Rows come back ordered by id, and an id order is not a time order once a
    // tag carries an explicit timestamp.
    const result = latestTags([
      tag(1, 'a', 'valuable', '2026-09-03T10:00:00.000Z'),
      tag(1, 'a', 'nuisance', '2026-09-01T10:00:00.000Z'),
    ]);
    expect(result[0]?.outcome).toBe('valuable');
  });

  it('breaks a timestamp tie by input order, so the report is reproducible', () => {
    const same = '2026-09-01T10:00:00.000Z';
    const result = latestTags([tag(1, 'a', 'nuisance', same), tag(1, 'a', 'valuable', same)]);
    expect(result[0]?.outcome).toBe('valuable');
  });

  it('returns nothing for nothing', () => {
    expect(latestTags([])).toEqual([]);
  });
});

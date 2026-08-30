import { describe, expect, it } from 'vitest';
import { adoptionBar, type BlockRecord } from './adoption-bar.js';
import type { BlockOutcomeTag } from './block-outcome.js';

/**
 * The five signals (P8-BAR-02, ADR-0063, metrics.md §3a).
 *
 * The tests that matter here are the empty ones. A report that answers `0%`
 * when it has no data would tell somebody their gates are worthless on the day
 * they installed the tool, and the first thing they would do about it is loosen
 * gates that were fine.
 */

const block = (gateId: number, blockedAt: string): BlockRecord => ({
  gateId,
  workItemId: `FEAT-${String(gateId)}`,
  gateName: 'verify',
  blockedAt,
});

const tag = (
  gateId: number,
  outcome: 'valuable' | 'nuisance',
  taggedAt = '2026-09-05T00:00:00.000Z',
  actorId = 'a-1',
): BlockOutcomeTag => ({ gateId, actorId, outcome, reason: null, taggedAt });

const empty = { blocks: [], tags: [], configEvents: [], overrides: 0 };

describe('adoptionBar with no data', () => {
  it('reports every rate as unavailable rather than zero', () => {
    const bar = adoptionBar(empty);
    expect(bar.valuableRate.value).toBeNull();
    expect(bar.nuisanceRate.value).toBeNull();
    expect(bar.blocksToFirstValuable.value).toBeNull();
    expect(bar.downgradeRate.value).toBeNull();
    expect(bar.overrideRate.value).toBeNull();
  });

  it('says the bar is unmeasured, not unmet', () => {
    // These are opposite facts with opposite responses, and a boolean cannot
    // hold both.
    const bar = adoptionBar(empty);
    expect(bar.met).toBeNull();
    expect(bar.because).toContain('unmeasured');
  });

  it('names the command that would produce the missing data', () => {
    const bar = adoptionBar(empty);
    expect(bar.valuableRate.because).toContain('sdlc gates tag');
    expect(bar.downgradeRate.because).toContain('sdlc config:snapshot');
  });

  it('distinguishes blocks-with-no-judgements from no-blocks-at-all', () => {
    const bar = adoptionBar({ ...empty, blocks: [block(1, '2026-09-01T00:00:00.000Z')] });
    expect(bar.untagged).toBe(1);
    expect(bar.met).toBeNull();
    expect(bar.overrideRate.value).toBe(0); // a real 0: one block, no overrides
  });
});

describe('adoptionBar rates', () => {
  const blocks = [
    block(1, '2026-09-01T00:00:00.000Z'),
    block(2, '2026-09-02T00:00:00.000Z'),
    block(3, '2026-09-03T00:00:00.000Z'),
  ];

  it('computes valuable and nuisance over judged blocks only', () => {
    // The denominator is judged blocks, not all blocks. Using all blocks would
    // drive the valuable rate down every time somebody did not bother to tag,
    // which measures tagging diligence rather than gate value.
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [tag(1, 'valuable'), tag(2, 'nuisance')],
    });
    expect(bar.valuableRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(bar.nuisanceRate).toMatchObject({ numerator: 1, denominator: 2 });
    expect(bar.untagged).toBe(1);
  });

  it('honours a changed mind — the latest tag is the one that counts', () => {
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [
        tag(1, 'nuisance', '2026-09-04T00:00:00.000Z'),
        tag(1, 'valuable', '2026-09-06T00:00:00.000Z'),
      ],
    });
    expect(bar.valuableRate).toMatchObject({ numerator: 1, denominator: 1 });
    expect(bar.nuisanceRate?.numerator).toBe(0);
  });

  it('resolves a changed mind by timestamp, not by row order', () => {
    // Rows come back ordered by id, and an id order is not a time order. A
    // reduction that just took the last row it saw would agree with this on
    // every ordinary input and disagree exactly when somebody's clock skewed or
    // a tag was backdated — which is when a wrong answer is hardest to notice.
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [
        tag(1, 'valuable', '2026-09-06T00:00:00.000Z'),
        tag(1, 'nuisance', '2026-09-04T00:00:00.000Z'),
      ],
    });
    expect(bar.valuableRate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('counts blocks up to and including the first valuable one', () => {
    // Zero would mean no block was needed, which cannot happen: the first
    // valuable block is itself a block.
    const bar = adoptionBar({ ...empty, blocks, tags: [tag(3, 'valuable')] });
    expect(bar.blocksToFirstValuable.value).toBe(3);
  });

  it('orders blocks by time, not by the order they were handed over', () => {
    const bar = adoptionBar({
      ...empty,
      blocks: [blocks[2]!, blocks[0]!, blocks[1]!],
      tags: [tag(1, 'valuable')],
    });
    expect(bar.blocksToFirstValuable.value).toBe(1);
  });

  it('reports blocks-to-first-valuable as unavailable when there has not been one', () => {
    const bar = adoptionBar({ ...empty, blocks, tags: [tag(1, 'nuisance')] });
    expect(bar.blocksToFirstValuable.value).toBeNull();
    expect(bar.blocksToFirstValuable.because).toContain('not been cleared');
  });
});

describe('whether the bar is met', () => {
  const blocks = [block(1, '2026-09-01T00:00:00.000Z'), block(2, '2026-09-02T00:00:00.000Z')];

  it('is met when a block was valuable, nuisance does not exceed it, and nothing was weakened', () => {
    const bar = adoptionBar({ ...empty, blocks, tags: [tag(1, 'valuable')] });
    expect(bar.met).toBe(true);
  });

  it('is not met when every judged block was a nuisance', () => {
    const bar = adoptionBar({ ...empty, blocks, tags: [tag(1, 'nuisance')] });
    expect(bar.met).toBe(false);
    expect(bar.because).toContain('no block has been judged valuable');
  });

  it('is not met when nuisances outnumber the valuable ones', () => {
    const bar = adoptionBar({
      ...empty,
      blocks: [...blocks, block(3, '2026-09-03T00:00:00.000Z')],
      tags: [tag(1, 'valuable'), tag(2, 'nuisance'), tag(3, 'nuisance')],
    });
    expect(bar.met).toBe(false);
  });

  it('reports a tag whose gate is missing rather than dropping it from the denominator', () => {
    // Zero in normal use, because a tag can only exist on a failed gate. It
    // stops being zero the moment a caller scopes the block query — and a rate
    // quietly computed over a subset of the evidence is exactly what this
    // module exists to refuse.
    const bar = adoptionBar({ ...empty, blocks, tags: [tag(1, 'valuable'), tag(99, 'nuisance')] });
    expect(bar.orphanTags).toEqual([99]);
    expect(bar.valuableRate).toMatchObject({ numerator: 1, denominator: 1 });
  });

  it('is not met when the gates were weakened, however good the tags look', () => {
    // Somebody dropping to `lite` after a valuable block has still voted with
    // their config, and that vote outranks the tag.
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [tag(1, 'valuable')],
      configEvents: [{ observedAt: '2026-09-03T00:00:00.000Z', direction: 'weakened' }],
    });
    expect(bar.met).toBe(false);
    expect(bar.because).toContain('downgrade');
  });

  it('counts a `mixed` config event as a downgrade', () => {
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [tag(1, 'valuable')],
      configEvents: [{ observedAt: '2026-09-03T00:00:00.000Z', direction: 'mixed' }],
    });
    expect(bar.met).toBe(false);
  });

  it('does not count a strengthening as a downgrade', () => {
    const bar = adoptionBar({
      ...empty,
      blocks,
      tags: [tag(1, 'valuable')],
      configEvents: [{ observedAt: '2026-09-03T00:00:00.000Z', direction: 'strengthened' }],
    });
    expect(bar.met).toBe(true);
    expect(bar.downgradeRate.value).toBe(0);
  });
});

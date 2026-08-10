import { describe, expect, it } from 'vitest';
import {
  ContextPackSchema,
  ContextPackSpecSchema,
  type ContextPack,
  type ContextPackSpec,
} from '@sdlc-on-fire/core';
import { assembleContextPack } from './assemble.js';
import {
  MIN_CACHEABLE_TOKENS,
  packMetrics,
  renderCacheAware,
  summariseMetrics,
} from './metrics.js';

/**
 * Cache-aware rendering and pack metrics (P1-CTX-06).
 *
 * Two gaps, and they are one gap seen from two sides: the cache boundary was
 * computed and never used, and a pack truncated to fit was indistinguishable
 * from a pack that simply had less to say. The second is the expensive one —
 * when an agent answers badly, "was it given everything?" is the first question
 * and the pack could not answer it.
 */

const layer = (kind: ContextPack['layers'][number]['kind'], tokens: number) => ({
  kind,
  content: 'x'.repeat(tokens * 4),
  tokens,
});

const pack = (over: Partial<ContextPack> = {}): ContextPack =>
  ContextPackSchema.parse({
    packId: '11111111-1111-4111-8111-111111111111',
    skillId: 'implement',
    stageId: 'implement',
    cardId: 'TASK-001',
    effortTier: 'max',
    layers: [layer('skill-stable', 2000), layer('card-core', 500)],
    stableUpToIndex: 0,
    totalTokens: 2500,
    assembledAt: '2026-08-10T00:00:00.000Z',
    ...over,
  });

describe('measuring a pack', () => {
  it('reports utilisation against the budget it was assembled for', () => {
    const metrics = packMetrics(pack(), 4000);
    expect(metrics.used).toBe(2500);
    expect(metrics.utilisation).toBe(0.625);
  });

  it('does not infer the budget from the pack, which would make utilisation meaningless', () => {
    // Inferring it from `totalTokens` makes utilisation definitionally 1.0 — a
    // metric that looks healthiest exactly when it is measuring nothing.
    expect(packMetrics(pack(), 2500).utilisation).toBe(1);
    expect(packMetrics(pack(), 10_000).utilisation).toBe(0.25);
  });

  it('counts only the stable prefix as cacheable', () => {
    const metrics = packMetrics(pack(), 4000);
    expect(metrics.cacheablePrefixTokens).toBe(2000);
    expect(metrics.cacheableFraction).toBe(0.8);
  });

  it('reports nothing cacheable when the boundary is before the first layer', () => {
    const metrics = packMetrics(pack({ stableUpToIndex: -1 }), 4000);
    expect(metrics.cacheablePrefixTokens).toBe(0);
    expect(metrics.cacheableFraction).toBe(0);
  });
});

describe('rendering for a cache breakpoint', () => {
  it('returns prefix and suffix separately rather than embedding a marker', () => {
    // A marker inside the text becomes part of the text: it changes the bytes
    // the provider hashes, so a marked and unmarked render would never share a
    // cache entry. The mechanism would quietly defeat itself.
    const rendered = renderCacheAware(pack());
    expect(rendered.prefix).not.toContain('CACHE');
    expect(rendered.suffix).not.toContain('CACHE');
    expect(rendered.prefix.length).toBeGreaterThan(0);
    expect(rendered.suffix.length).toBeGreaterThan(0);
  });

  it('reassembles to exactly the rendered pack', () => {
    // If the split loses or adds a byte, every cache lookup misses silently and
    // costs full price.
    const rendered = renderCacheAware(pack());
    expect(`${rendered.prefix}\n\n${rendered.suffix}`).toBe(
      pack()
        .layers.map((entry) => entry.content)
        .join('\n\n'),
    );
  });

  it('says a short prefix is not worth caching', () => {
    // Providers charge a write premium, so caching 200 tokens costs more than
    // it saves. A threshold, not a model deciding whether it feels worthwhile.
    const small = pack({
      layers: [layer('skill-stable', 200), layer('card-core', 500)],
      totalTokens: 700,
    });
    expect(renderCacheAware(small).worthCaching).toBe(false);
    expect(renderCacheAware(pack()).worthCaching).toBe(true);
    expect(MIN_CACHEABLE_TOKENS).toBeGreaterThan(0);
  });
});

describe('what the assembler left out', () => {
  const base = {
    cardCore: 'card core content',
    skillStable: 'skill instructions',
    cardId: 'TASK-001',
  };
  const spec = (max: number): ContextPackSpec =>
    ContextPackSpecSchema.parse({
      skillId: 'implement',
      stageId: 'implement',
      budget: { max },
      sources: { include: [{ kind: 'work_item', id: 'TASK-001' }] },
      freshness: { revalidateOnAssembly: true },
      isolation: 'fresh-subagent',
      disposer: 'assembleContextPack.truncateToBudget',
    });

  it('records a layer dropped for budget, distinctly from one never offered', async () => {
    // The difference the pack could not previously express — and the first thing
    // you need when an agent answers badly.
    const assembled = await assembleContextPack({
      spec: spec(30),
      ...base,
      rollingState: 'x'.repeat(400),
    });

    const dropped = assembled.dropped.find((entry) => entry.kind === 'rolling-state');
    expect(dropped?.reason).toBe('budget');
    expect(dropped?.tokens).toBeGreaterThan(0);

    const absent = assembled.dropped.find((entry) => entry.kind === 'comment-directives');
    expect(absent?.reason).toBe('absent');
    expect(absent?.tokens).toBe(0);
  });

  it('says so in the summary, so a healthy-looking count cannot mislead', async () => {
    const assembled = await assembleContextPack({
      spec: spec(30),
      ...base,
      rollingState: 'x'.repeat(400),
    });
    const summary = summariseMetrics(
      packMetrics(assembled.pack, assembled.budget, assembled.dropped),
    );
    expect(summary).toMatch(/DROPPED to fit: rolling-state/);
  });

  it('reports no budget drops when everything fitted', async () => {
    const assembled = await assembleContextPack({ spec: spec(10_000), ...base });
    expect(assembled.dropped.filter((entry) => entry.reason === 'budget')).toEqual([]);
    expect(
      summariseMetrics(packMetrics(assembled.pack, assembled.budget, assembled.dropped)),
    ).not.toMatch(/DROPPED/);
  });
});

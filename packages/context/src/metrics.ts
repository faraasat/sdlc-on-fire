import type { ContextLayerKind, ContextPack } from '@sdlc-on-fire/core';

/**
 * Prompt-cache-aware rendering and pack metrics (P1-CTX-06).
 *
 * Two things were missing, and they are the same thing seen from two sides.
 *
 * **The cache boundary was computed and never used.** `stableUpToIndex` and
 * `stablePrefix` existed; nothing rendered a pack in a form a provider could
 * actually cache against, so the boundary was a number in a struct rather than a
 * saving on a bill.
 *
 * **A truncated pack was indistinguishable from a small one.** Optional layers
 * were dropped silently to fit the budget, so a pack assembled without retrieval
 * because there was none, and a pack assembled without retrieval because it did
 * not fit, rendered identically. When an agent then answers badly, that is
 * precisely the difference you need and cannot get.
 *
 * Everything here is derived arithmetic over the pack, never a model call — a
 * metric nobody can reproduce is an anecdote.
 */

/** Why a layer is absent from a pack. */
export type DropReason = 'budget' | 'absent';

export interface DroppedLayer {
  readonly kind: ContextLayerKind;
  readonly reason: DropReason;
  /** Tokens the layer would have cost, when it existed and was dropped. */
  readonly tokens: number;
}

export interface PackMetrics {
  readonly packId: string;
  readonly budget: number;
  readonly used: number;
  /** `used / budget`, 0..1. Rounded to three places so it reads as a number, not noise. */
  readonly utilisation: number;
  readonly byLayer: Readonly<Partial<Record<ContextLayerKind, number>>>;
  /**
   * Tokens in the byte-identical prefix a provider can cache.
   *
   * The number that decides whether prompt caching is worth enabling at all —
   * a boundary at token 40 of a 6,000-token pack saves nothing.
   */
  readonly cacheablePrefixTokens: number;
  /** `cacheablePrefixTokens / used`, 0..1. */
  readonly cacheableFraction: number;
  /**
   * Layers not present, and why.
   *
   * `budget` is the one that matters: it means the agent was given less than the
   * assembler wanted it to have, and nothing else in the pack records that.
   */
  readonly dropped: readonly DroppedLayer[];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Measures a pack against the budget it was assembled for.
 *
 * `budget` is passed rather than read off the pack because the pack does not
 * carry it — and inferring it from `totalTokens` would make utilisation
 * definitionally 1.0, which is the kind of metric that looks healthy precisely
 * when it is measuring nothing.
 */
export function packMetrics(
  pack: ContextPack,
  budget: number,
  dropped: readonly DroppedLayer[] = [],
): PackMetrics {
  const byLayer: Partial<Record<ContextLayerKind, number>> = {};
  for (const layer of pack.layers) byLayer[layer.kind] = layer.tokens;

  const cacheablePrefixTokens = pack.layers
    .slice(0, pack.stableUpToIndex + 1)
    .reduce((sum, layer) => sum + layer.tokens, 0);

  return {
    packId: pack.packId,
    budget,
    used: pack.totalTokens,
    utilisation: budget === 0 ? 0 : round(pack.totalTokens / budget),
    byLayer,
    cacheablePrefixTokens,
    cacheableFraction: pack.totalTokens === 0 ? 0 : round(cacheablePrefixTokens / pack.totalTokens),
    dropped,
  };
}

export interface CacheAwareRender {
  /**
   * The byte-identical prefix. A provider cache breakpoint goes immediately
   * after this, and it must be reproduced *exactly* on the next call or the
   * cache misses silently and costs full price.
   */
  readonly prefix: string;
  /** Everything after the breakpoint — volatile on every invocation. */
  readonly suffix: string;
  /** Whether a breakpoint is worth setting at all. */
  readonly worthCaching: boolean;
}

/**
 * Minimum prefix worth a cache breakpoint.
 *
 * Providers charge a write premium on a cache entry, so caching a 200-token
 * prefix costs more than it saves. The threshold is conservative and stated
 * here rather than hidden in a caller, so the decision is one anyone can argue
 * with — and it is a threshold, not a model asking itself whether caching seems
 * worthwhile.
 */
export const MIN_CACHEABLE_TOKENS = 1024;

/**
 * Splits a pack at its cache boundary.
 *
 * Deliberately returns two strings rather than one with a marker in it. A marker
 * inside the text becomes part of the text: it changes the bytes the provider
 * hashes, so a pack rendered with a marker and one rendered without would never
 * share a cache entry — the mechanism would quietly defeat itself.
 */
export function renderCacheAware(pack: ContextPack): CacheAwareRender {
  const prefixLayers = pack.layers.slice(0, pack.stableUpToIndex + 1);
  const suffixLayers = pack.layers.slice(pack.stableUpToIndex + 1);
  const prefixTokens = prefixLayers.reduce((sum, layer) => sum + layer.tokens, 0);

  return {
    prefix: prefixLayers.map((layer) => layer.content).join('\n\n'),
    suffix: suffixLayers.map((layer) => layer.content).join('\n\n'),
    worthCaching: prefixTokens >= MIN_CACHEABLE_TOKENS,
  };
}

/**
 * One line a human can read, for `sdlc instructions`.
 *
 * The dropped layers are named. "3,900/4,000 tokens" reads like a healthy pack
 * right up until you learn retrieval was cut to reach it.
 */
export function summariseMetrics(metrics: PackMetrics): string {
  const parts = [
    `${String(metrics.used)}/${String(metrics.budget)} tokens (${String(Math.round(metrics.utilisation * 100))}%)`,
    `${String(metrics.cacheablePrefixTokens)} cacheable`,
  ];
  const budgetDropped = metrics.dropped.filter((entry) => entry.reason === 'budget');
  if (budgetDropped.length > 0) {
    parts.push(
      `DROPPED to fit: ${budgetDropped.map((entry) => `${entry.kind} (${String(entry.tokens)} tokens)`).join(', ')}`,
    );
  }
  return parts.join(' · ');
}

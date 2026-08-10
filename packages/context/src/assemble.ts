import { randomUUID } from 'node:crypto';
import {
  ContextPackSchema,
  type ContextLayer,
  type ContextLayerKind,
  type ContextPack,
  type ContextPackSpec,
  type EffortTier,
} from '@sdlc-on-fire/core';

/**
 * Context pack assembly (contracts/05, ADR-0018).
 *
 * v0.1 scope (mvp-slice): card-core always, a stable prefix, and **tsvector**
 * retrieval. Embeddings and hybrid rerank are v0.2.
 *
 * `assembleContextPack` is the **deterministic disposer** for what tokens enter
 * the pack (ADR-0040). Retrieval may over-fetch and propose candidates;
 * truncation and layer ordering are pure code. No model call participates.
 */

export interface RetrievedChunk {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly tokens: number;
}

/** Pluggable retrieval. v0.1 supplies a tsvector-backed one; v0.2 adds vectors. */
export type Retriever = (query: string, limit: number) => Promise<RetrievedChunk[]>;

export interface AssembleInput {
  readonly spec: ContextPackSpec;
  readonly cardId: string;
  readonly effortTier?: EffortTier | undefined;
  /** Skill instructions — stable across invocations of the same skill. */
  readonly skillStable: string;
  /** The work item's own content. Always included; never truncated away. */
  readonly cardCore: string;
  /** Rolling memory for this item, when it exists. */
  readonly rollingState?: string | undefined;
  /** Live-steering comment directives (P1-CMT-02 feeds this). */
  readonly commentDirectives?: string | undefined;
  readonly retrieve?: Retriever | undefined;
  /** Injectable for tests; production passes nothing. */
  readonly packId?: string | undefined;
  readonly now?: Date | undefined;
}

/**
 * Token estimate.
 *
 * Deliberately crude — ~4 characters per token — and named so nobody mistakes it
 * for a tokenizer. The budget it enforces is a safety rail, not an exact
 * accounting; a real tokenizer arrives with the embedder in v0.2.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Layer order, stable-prefix-first (contracts/05 §3.2). */
const LAYER_ORDER: readonly ContextLayerKind[] = [
  'skill-stable',
  'rolling-state',
  'card-core',
  'comment-directives',
  'retrieval',
];

/** Layers identical across invocations of the same skill at the same content state. */
const STABLE_LAYERS: readonly ContextLayerKind[] = ['skill-stable'];

export class BudgetTooSmallError extends Error {
  override readonly name = 'BudgetTooSmallError';
  constructor(required: number, budget: number) {
    super(
      `card-core alone needs ${required} tokens but the budget is ${budget}. ` +
        'Truncating the work item itself would hand the agent a task it cannot read.',
    );
  }
}

/**
 * Assembles a pack.
 *
 * Truncation order is the design: retrieval is dropped first, then optional
 * layers, and **card-core is never truncated** — an agent given a partial task
 * description will confidently do the wrong thing, which is worse than failing
 * loudly.
 */
export async function assembleContextPack(input: AssembleInput): Promise<ContextPack> {
  const effortTier: EffortTier = input.effortTier ?? 'max';
  const budget =
    effortTier === 'low' ? (input.spec.budget.low ?? input.spec.budget.max) : input.spec.budget.max;

  const candidates = new Map<ContextLayerKind, string>();
  candidates.set('skill-stable', input.skillStable);
  candidates.set('card-core', input.cardCore);
  if (input.rollingState !== undefined) candidates.set('rolling-state', input.rollingState);
  if (input.commentDirectives !== undefined) {
    candidates.set('comment-directives', input.commentDirectives);
  }

  const cardCoreTokens = estimateTokens(input.cardCore);
  if (cardCoreTokens > budget) throw new BudgetTooSmallError(cardCoreTokens, budget);

  // Retrieval runs last and gets whatever budget survives. Over-fetching here is
  // fine — this function, not the retriever, decides what is kept.
  let spent = 0;
  for (const kind of LAYER_ORDER) {
    const content = candidates.get(kind);
    if (content !== undefined) spent += estimateTokens(content);
  }

  if (input.retrieve !== undefined && spent < budget) {
    const chunks = await input.retrieve(input.cardCore, 20);
    const kept: string[] = [];
    let retrievalTokens = 0;
    for (const chunk of [...chunks].sort((a, b) => b.score - a.score)) {
      if (spent + retrievalTokens + chunk.tokens > budget) break;
      kept.push(chunk.text);
      retrievalTokens += chunk.tokens;
    }
    if (kept.length > 0) candidates.set('retrieval', kept.join('\n\n'));
  }

  // Drop optional layers, cheapest-value-first, until the budget is met.
  const layers: ContextLayer[] = [];
  const dropOrder: ContextLayerKind[] = ['retrieval', 'comment-directives', 'rolling-state'];
  let total = LAYER_ORDER.reduce(
    (sum, kind) => sum + estimateTokens(candidates.get(kind) ?? ''),
    0,
  );
  for (const kind of dropOrder) {
    if (total <= budget) break;
    const content = candidates.get(kind);
    if (content === undefined) continue;
    total -= estimateTokens(content);
    candidates.delete(kind);
  }

  for (const kind of LAYER_ORDER) {
    const content = candidates.get(kind);
    if (content === undefined || content.trim().length === 0) continue;
    layers.push({ kind, content, tokens: estimateTokens(content) });
  }

  // The boundary is computed from what was actually emitted, so an absent
  // optional layer cannot push it past volatile content.
  let stableUpToIndex = -1;
  for (const [index, layer] of layers.entries()) {
    if (!STABLE_LAYERS.includes(layer.kind)) break;
    stableUpToIndex = index;
  }

  const pack = {
    packId: input.packId ?? randomUUID(),
    skillId: input.spec.skillId,
    stageId: input.spec.stageId,
    cardId: input.cardId,
    effortTier,
    layers,
    stableUpToIndex,
    totalTokens: layers.reduce((sum, layer) => sum + layer.tokens, 0),
    // Volatile by nature, so it lives on the pack, never inside a cached layer.
    assembledAt: (input.now ?? new Date()).toISOString(),
  };

  // Validated on the way out: the pack's own invariants (token sum, cache
  // boundary in range) are asserted rather than assumed.
  return ContextPackSchema.parse(pack);
}

/** Concatenates layers in order — the array *is* the prompt content (contracts/05 §3.2). */
export function renderPack(pack: ContextPack): string {
  return pack.layers.map((layer) => layer.content).join('\n\n');
}

/** The byte-identical prefix eligible for a cache breakpoint. */
export function stablePrefix(pack: ContextPack): string {
  return pack.layers
    .slice(0, pack.stableUpToIndex + 1)
    .map((layer) => layer.content)
    .join('\n\n');
}

import { z } from 'zod';

/**
 * Context-pack shapes, per contracts/05-context-and-handoff.md §2–§3.
 *
 * v0.1 ships the MVP subset the contract marks: `skillId`, `stageId`,
 * `budget.max`, `sources.include`, `freshness.revalidateOnAssembly`, and
 * `isolation`. The `low` effort tier, `sources.exclude` glob matching, and
 * per-skill retrieval overrides are deferred — the fields are present so the
 * type does not need a breaking change when Phase 1 turns them on.
 */

export const SOURCE_REF_KINDS = ['spec', 'decision', 'change', 'work_item'] as const;
export const SourceRefSchema = z.object({
  kind: z.enum(SOURCE_REF_KINDS),
  id: z.string().min(1),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SourceGlobSchema = z.object({ path: z.string().min(1) });

export const EFFORT_TIERS = ['low', 'max'] as const;
export const EffortTierSchema = z.enum(EFFORT_TIERS);
export type EffortTier = z.infer<typeof EffortTierSchema>;

/**
 * Whether a stage runs as a fresh-context sub-agent (returns a capped structured
 * summary, never a full transcript) or in-line in the orchestrator's own context.
 */
export const ISOLATION_MODES = ['fresh-subagent', 'inline'] as const;
export const IsolationModeSchema = z.enum(ISOLATION_MODES);
export type IsolationMode = z.infer<typeof IsolationModeSchema>;

export const ContextPackSpecSchema = z.object({
  skillId: z.string().min(1),
  stageId: z.string().min(1),
  budget: z.object({
    max: z.number().int().positive(),
    /** Deferred to Phase 1 — effort-tier selection is not exercised in v0.1. */
    low: z.number().int().positive().optional(),
  }),
  sources: z.object({
    include: z.array(SourceRefSchema),
    exclude: z.array(SourceGlobSchema).optional(),
  }),
  freshness: z.object({
    maxContentAgeMs: z.number().int().positive().optional(),
    /** Hardcoded true in v0.1: re-check content_hash against HEAD before inserting a chunk. */
    revalidateOnAssembly: z.boolean(),
  }),
  isolation: IsolationModeSchema,
  /**
   * Named explicitly per the contracts convention that every contract names its
   * deterministic disposer (ADR-0040). Truncation to budget is pure code; no LLM
   * call participates in pack assembly.
   */
  disposer: z.literal('assembleContextPack.truncateToBudget'),
});

export type ContextPackSpec = z.infer<typeof ContextPackSpecSchema>;

/**
 * Layer kinds, ordered stable-prefix-first. The array order in a
 * {@link ContextPackSchema} *is* the contract, not an implementation detail —
 * layers are concatenated in order to form the prompt.
 */
export const CONTEXT_LAYER_KINDS = [
  'skill-stable',
  'rolling-state',
  'card-core',
  'comment-directives',
  'retrieval',
] as const;
export const ContextLayerKindSchema = z.enum(CONTEXT_LAYER_KINDS);
export type ContextLayerKind = z.infer<typeof ContextLayerKindSchema>;

export const ContextLayerSchema = z.object({
  kind: ContextLayerKindSchema,
  content: z.string(),
  tokens: z.number().int().nonnegative(),
});
export type ContextLayer = z.infer<typeof ContextLayerSchema>;

export const ContextPackSchema = z
  .object({
    packId: z.uuid(),
    skillId: z.string().min(1),
    stageId: z.string().min(1),
    cardId: z.string().min(1),
    effortTier: EffortTierSchema,
    layers: z.array(ContextLayerSchema),
    /**
     * Inclusive index up to which content is byte-identical across repeat
     * invocations at the same content-hash state — the cache breakpoint.
     */
    stableUpToIndex: z.number().int().gte(-1),
    totalTokens: z.number().int().nonnegative(),
    /** Volatile by nature, so it lives on the pack and never inside a cached layer. */
    assembledAt: z.iso.datetime(),
  })
  .superRefine((pack, ctx) => {
    if (pack.stableUpToIndex >= pack.layers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['stableUpToIndex'],
        message: `stableUpToIndex ${pack.stableUpToIndex} is out of range for ${pack.layers.length} layer(s)`,
      });
    }

    // The pack's own token count must match its layers, or budget enforcement
    // downstream is measuring something that does not exist.
    const summed = pack.layers.reduce((total, layer) => total + layer.tokens, 0);
    if (summed !== pack.totalTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalTokens'],
        message: `totalTokens ${pack.totalTokens} does not match the sum of layer tokens (${summed})`,
      });
    }
  });

export type ContextPack = z.infer<typeof ContextPackSchema>;

/**
 * Whether a pack respects its spec's budget for the given tier. The deterministic
 * disposer for "did assembly actually stay inside the budget" — asserted after
 * assembly rather than trusted from it.
 */
export function isWithinBudget(pack: ContextPack, spec: ContextPackSpec): boolean {
  const budget = pack.effortTier === 'low' ? (spec.budget.low ?? spec.budget.max) : spec.budget.max;
  return pack.totalTokens <= budget;
}

/**
 * Token estimate — one implementation, shared.
 *
 * Deliberately crude (~4 characters per token) and named so nobody mistakes it
 * for a tokenizer. The budgets it enforces are safety rails, not exact
 * accounting; a real tokenizer arrives with the embedder.
 *
 * **It lives in `core` since P8-EVID-03 because three modules needed it.**
 * `context/assemble.ts` had one and `agent-manager/adapters/tool-budget.ts` had
 * a second, deliberately copied with a comment explaining that agent-manager
 * must not depend on the context engine "for one line of arithmetic" — a sound
 * constraint that pointed at the wrong fix, since both already depend on `core`.
 * A guard test kept the two honest, which is the tell: a rule that needs a test
 * to stop two copies drifting is a rule that wanted one copy.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

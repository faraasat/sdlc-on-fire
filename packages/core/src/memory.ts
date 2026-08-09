import { z } from 'zod';
import { WorkItemIdSchema } from './ids.js';
import { LifecycleStageSchema } from './lifecycle.js';

/**
 * Rolling per-work-item memory, per contracts/02-object-model.md §4.8.
 *
 * This is the file the context engine's hierarchical compaction writes at the
 * end of each stage — the "rolling STATE" that survives a fresh-context agent
 * session. v0.1 ships the schema only; the compaction that populates it is
 * Phase 1 (`P1-SKILL-03`).
 */

/**
 * Soft ceiling on the rolling summary, in characters. The contract specifies
 * 1–2K *tokens*; tokenization lives in `packages/context`, so core enforces a
 * generous character bound that catches a runaway summary without pretending to
 * count tokens it cannot see.
 */
export const MEMORY_SUMMARY_MAX_CHARS = 12_000;

export const MemorySchema = z.object({
  $schema: z.url(),
  work_item_id: WorkItemIdSchema,
  stage: LifecycleStageSchema,
  summary: z.string().min(1).max(MEMORY_SUMMARY_MAX_CHARS),
  updated_at: z.iso.datetime(),
});

export type Memory = z.infer<typeof MemorySchema>;

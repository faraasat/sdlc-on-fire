import { z } from 'zod';
import { LifecycleStageSchema } from './lifecycle.js';

/**
 * Typed stage handoffs and source-pointer rehydration (P1-CTX-07/08, ADR-0021).
 *
 * A stage boundary used to carry free text. The orchestration literature names
 * the failure mode that causes — brittle handoffs and loss of decision-relevant
 * context — and the mechanism is mundane: the next stage has to re-parse prose
 * to learn what was decided and what is still open, and nothing notices when
 * something is silently dropped.
 *
 * Two properties earn the schema its keep. **Open questions are carried, not
 * summarised away** — compaction drops what looks least conclusive first, which
 * is exactly what an unresolved question looks like. And **every compacted
 * summary keeps a pointer home**, so a later stage that needs discarded detail
 * rehydrates it instead of re-running the stage that produced it.
 */

/**
 * Where a compacted summary came from, so the detail behind it can be fetched
 * again (ADR-0021: run id + stage + chunk range).
 */
export const SourcePointerSchema = z
  .object({
    runId: z.string().min(1),
    stage: LifecycleStageSchema,
    /** Pre-compaction content, as a path relative to the workspace root. */
    artifact: z.string().min(1),
    /** Inclusive chunk range within that artifact. */
    chunkFrom: z.number().int().nonnegative(),
    chunkTo: z.number().int().nonnegative(),
    /**
     * Hash of the pre-compaction content.
     *
     * Rehydration that quietly returned *different* text than was summarised
     * would be worse than no rehydration at all: the reader would believe they
     * were looking at the original.
     */
    contentHash: z.string().min(1),
  })
  .strict()
  .superRefine((pointer, ctx) => {
    if (pointer.chunkTo < pointer.chunkFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['chunkTo'],
        message: `chunk range ${String(pointer.chunkFrom)}..${String(pointer.chunkTo)} runs backwards`,
      });
    }
  });

/** A resolved reference back to pre-compaction content. */
export type SourcePointer = z.infer<typeof SourcePointerSchema>;

/** One decision a stage made, structured enough to be checked against later. */
export const StageDecisionSchema = z
  .object({
    /** What was decided, in one line. */
    statement: z.string().min(1),
    /** Why. One line or a reference — the rationale essay belongs in an ADR. */
    because: z.string().min(1),
    /** What would reverse it, when that is known. */
    reversedBy: z.string().optional(),
  })
  .strict();

/** A decision recorded at a stage boundary. */
export type StageDecision = z.infer<typeof StageDecisionSchema>;

/**
 * The part of a handoff a stage agent writes (ADR-0021's field list).
 *
 * Deliberately excludes `runId`/`workItemId`/`from`/`to`: the orchestrator knows
 * which boundary it just dispatched across, and a subagent's own account of
 * where it is would be one more claim to verify. The agent supplies content; the
 * caller supplies identity.
 */
export const AuthoredHandoffSchema = z
  .object({
    decisions: z.array(StageDecisionSchema).default([]),
    /**
     * What remains unresolved.
     *
     * Required, and an empty array is a legitimate answer — but it has to be
     * *stated* empty. A field that may be omitted is a field a compacting model
     * will omit, and "no open questions" and "we forgot to say" would then be
     * the same bytes.
     */
    openQuestions: z.array(z.string().min(1)),
    /** Concrete artifacts this stage read or wrote. */
    artifacts: z.array(z.string().min(1)).default([]),
    /** What the next stage needs, as data rather than inferred from prose. */
    requiredInputs: z.array(z.string().min(1)).default([]),
    /** Free-text detail, still bounded. Structure replaces prose; it does not ban it. */
    notes: z.string().default(''),
    /** Present when this handoff's narrative was compacted (P1-CTX-08). */
    source: SourcePointerSchema.optional(),
  })
  .strict();

/** The agent-authored content of a handoff, before the orchestrator stamps identity on it. */
export type AuthoredHandoff = z.infer<typeof AuthoredHandoffSchema>;

/** What one stage hands the next: authored content plus the boundary it crossed. */
export const StageHandoffSchema = AuthoredHandoffSchema.extend({
  schema_version: z.literal('1'),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
  from: LifecycleStageSchema,
  to: LifecycleStageSchema,
}).strict();

/** A validated stage handoff. */
export type StageHandoff = z.infer<typeof StageHandoffSchema>;

/** One structural reason a handoff should not be consumed as-is. */
export interface HandoffProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * Checks a handoff for structural problems, optionally against the one before it.
 *
 * Separate from the schema because these are facts about *continuity between*
 * handoffs rather than the shape of one object: a schema can say `openQuestions`
 * is an array of strings, and only a comparison can say the previous stage's
 * questions went missing.
 *
 * Returns every problem found rather than the first, so a stage that produced a
 * bad handoff learns everything wrong with it in one pass.
 */
export function handoffProblems(
  handoff: StageHandoff,
  previous?: StageHandoff,
): readonly HandoffProblem[] {
  const problems: HandoffProblem[] = [];

  if (handoff.from === handoff.to) {
    problems.push({ field: 'to', detail: 'a handoff must cross a stage boundary' });
  }

  if (handoff.source !== undefined && handoff.source.runId !== handoff.runId) {
    // A pointer into another run's artifacts is how rehydration silently
    // returns content from the wrong work.
    problems.push({
      field: 'source.runId',
      detail: `source pointer names run "${handoff.source.runId}" but this handoff is from run "${handoff.runId}"`,
    });
  }

  if (previous !== undefined) {
    if (previous.to !== handoff.from) {
      problems.push({
        field: 'from',
        detail: `previous handoff ended at "${previous.to}" but this one starts at "${handoff.from}"`,
      });
    }

    // Questions do not resolve by being forgotten. This is the one check that
    // pays for the whole schema: without it, "carried forward rather than
    // silently dropped" is an aspiration in an ADR rather than a property.
    const carried = new Set(handoff.openQuestions.map(normalise));
    const answered = new Set(handoff.decisions.map((decision) => normalise(decision.statement)));
    for (const question of previous.openQuestions) {
      const key = normalise(question);
      if (!carried.has(key) && !answered.has(key)) {
        problems.push({
          field: 'openQuestions',
          detail: `"${question}" was open at ${previous.to} and is neither carried forward nor recorded as decided`,
        });
      }
    }
  }

  return problems;
}

/** Whether a handoff is safe for the next stage to consume. */
export function isUsableHandoff(handoff: StageHandoff, previous?: StageHandoff): boolean {
  return handoffProblems(handoff, previous).length === 0;
}

/**
 * Matches questions to their answers across a boundary.
 *
 * Whitespace and case only. Anything cleverer — stemming, similarity — would let
 * a near-miss count as an answer, and the entire value of the check is that it
 * is the one thing here a model cannot talk its way past.
 */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

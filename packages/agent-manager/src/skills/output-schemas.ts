import { z } from 'zod';
import { AuthoredHandoffSchema } from '@sdlc-on-fire/core';

/**
 * What each skill's output contract actually means (P1-SKILL-01..03).
 *
 * Every canonical skill declared a `json_schema_ref` — `schemas/spec-output.schema.json`
 * and friends — and the prompt told the agent its arguments "must validate
 * against" it. No such file existed anywhere in the product, and nothing
 * validated anything. A blind evaluation went looking for the file and found the
 * whole contract was a sentence in a prompt.
 *
 * So the schemas live here, as the same kind of data the skills themselves are,
 * for the same reason: the workspace scaffolder that would emit `schemas/*.json`
 * is `P0-CLI-03` and deferred. The shape is identical; only the storage location
 * moves. What changed is that the reference now resolves and the contract is
 * *enforced* — an output that does not match is refused at the dispatch boundary
 * rather than described in a prompt and hoped for.
 */

/** An acceptance criterion, in the GIVEN/WHEN/THEN form the spec skill demands. */
const AcceptanceCriterionSchema = z
  .string()
  .min(1)
  .refine(
    (text) => /given/i.test(text) && /when/i.test(text) && /then/i.test(text),
    'acceptance criteria must be in GIVEN/WHEN/THEN form — the skill asks for it, so the contract checks it',
  );

export const SpecOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    summary: z.string().min(1),
    acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1),
    /**
     * Required and non-empty, matching P1-OBJ-06 on the spec object itself.
     * Scope creep is rarely a decision anyone makes; it is the absence of one,
     * and an empty non-goals list is what that absence looks like on disk.
     */
    non_goals: z.array(z.string().min(1)).min(1),
    open_questions: z.array(z.string().min(1)).default([]),
    /**
     * Required, not optional (ADR-0021, P1-CTX-07). An optional handoff is a
     * handoff no stage writes: the free-text summary would keep working, the
     * typed one would stay empty, and nothing would ever notice. `openQuestions`
     * still has to be *stated*, so "we resolved everything" and "we forgot to
     * carry them" remain distinguishable.
     */
    handoff: AuthoredHandoffSchema,
  })
  .strict();

export const ImplementOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    summary: z.string().min(1),
    /** Every file the agent claims to have touched, for the ownership check. */
    files_changed: z.array(z.string().min(1)).min(1),
    /** Which acceptance criteria this addresses, by index or text. */
    criteria_addressed: z.array(z.string().min(1)).default([]),
    notes: z.string().default(''),
    /** Required at the boundary — see {@link SpecOutputSchema}. */
    handoff: AuthoredHandoffSchema,
  })
  .strict();

export const ReviewOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    /**
     * At least one. A reviewer that approves every diff is indistinguishable
     * from one that never ran, which is why the review skill carries
     * HALT-on-zero-findings — the contract enforces what the prompt asks.
     */
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['blocker', 'major', 'minor', 'question']),
            file: z.string().min(1),
            summary: z.string().min(1),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    /** Required at the boundary — see {@link SpecOutputSchema}. */
    handoff: AuthoredHandoffSchema,
  })
  .strict();

export const RetrospectiveOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    /**
     * At most one, and none is the expected outcome for routine work. The
     * failure mode of a memory store is accumulation, not scarcity (ADR-0023).
     */
    memory_entries: z
      .array(
        z
          .object({
            claim: z.string().min(1),
            why_durable: z.string().min(1),
          })
          .strict(),
      )
      .max(1)
      .default([]),
    summary: z.string().min(1),
  })
  .strict();

export const ResolveConflictOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    /**
     * The declaration, per hunk — and the whole deliverable.
     *
     * The resolution itself is a file edit, which this schema deliberately does
     * not carry: an output saying "I resolved it" is a self-report, while an
     * output saying "hunk 0 kept ours and dropped theirs, because …" is a claim
     * `sdlc conflicts --check` can refuse. `kind` is what the agent believes it
     * did; the checker classifies the file independently and the two are
     * compared, so a wrong `kind` is caught rather than believed.
     */
    resolutions: z
      .array(
        z
          .object({
            file: z.string().min(1),
            hunk: z.number().int().min(0),
            kind: z.enum(['ours', 'theirs', 'union', 'synthesis']),
            /** What our side changed, relative to the common ancestor. */
            ours_intent: z.string().min(1),
            /** What their side changed. */
            theirs_intent: z.string().min(1),
            /**
             * Why this resolution is right, and what the discarded side was
             * for. Long enough to survive the checker's minimum, which exists
             * because "n/a" satisfies a required field without saying anything.
             */
            rationale: z.string().min(20),
          })
          .strict(),
      )
      .min(1),
    /** Required at the boundary — see {@link SpecOutputSchema}. */
    handoff: AuthoredHandoffSchema,
  })
  .strict();

/**
 * Every `json_schema_ref` a canonical skill may declare, and what it means.
 *
 * A skill whose ref is absent from this table cannot be dispatched — checked as
 * a test, so a new skill cannot ship a reference that points at nothing.
 */
export const OUTPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'schemas/spec-output.schema.json': SpecOutputSchema,
  'schemas/implement-output.schema.json': ImplementOutputSchema,
  'schemas/review-output.schema.json': ReviewOutputSchema,
  'schemas/retrospective-output.schema.json': RetrospectiveOutputSchema,
  'schemas/resolve-conflict-output.schema.json': ResolveConflictOutputSchema,
};

export function resolveOutputSchema(ref: string): z.ZodType | undefined {
  return OUTPUT_SCHEMAS[ref];
}

/**
 * The JSON Schema an agent is actually being asked to satisfy.
 *
 * Generated from the Zod schema rather than maintained beside it: two
 * hand-written descriptions of one contract disagree eventually, and the one in
 * the prompt is the copy nobody re-reads.
 */
export function outputJsonSchema(ref: string): unknown {
  const schema = resolveOutputSchema(ref);
  if (schema === undefined) return undefined;
  return z.toJSONSchema(schema, { io: 'input' });
}

import { TEST_TIERS } from '@sdlc-on-fire/core';
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

/* ---- planning skills (P6-PAYLOAD-01) ---- */

/**
 * Every planning schema carries `blocked_on`.
 *
 * A planning skill that cannot say "I could not plan this, here is what is
 * missing" will invent the plan instead — and an invented plan is worse than an
 * absent one, because it looks like work and is acted on. The field is optional
 * and its presence is the skill's escape hatch.
 */
const BlockedOn = z.array(z.string().min(1)).optional();

export const DiscoveryOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    problem: z.string().min(1),
    affected: z.array(z.object({ who: z.string().min(1), evidence: z.string().min(1) })),
    constraints: z.array(z.object({ constraint: z.string().min(1), source: z.string().min(1) })),
    open_questions: z.array(z.string().min(1)),
    // Kept apart on purpose: a reader must be able to tell what somebody said
    // from what the agent worked out, and a single list loses that forever.
    inferred: z.array(z.string().min(1)).default([]),
    blocked_on: BlockedOn,
  })
  .strict();

export const DecomposeOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    children: z.array(
      z.object({
        title: z.string().min(1),
        kind: z.enum(['story', 'task', 'bug']),
        acceptance_criteria: z.array(z.string().min(1)).min(1),
        verify_command: z.string().min(1),
        /** Declared so two children cannot be run in parallel against one file. */
        owns_files: z.array(z.string().min(1)).default([]),
        traces_to: z.string().min(1),
      }),
    ),
    blocked_on: BlockedOn,
  })
  .strict();

export const PlanStoryOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    steps: z.array(
      z.object({
        step: z.string().min(1),
        files: z.array(z.string().min(1)).default([]),
      }),
    ),
    verify_command: z.string().min(1),
    assumptions: z.array(z.string().min(1)).default([]),
    non_goals: z.array(z.string().min(1)).default([]),
    blocked_on: BlockedOn,
  })
  .strict();

export const ArchitectureOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    boundaries: z.array(z.object({ module: z.string().min(1), owns: z.string().min(1) })),
    crossings: z.array(z.string().min(1)).default([]),
    decisions: z.array(
      z.object({
        decision: z.string().min(1),
        // Required, both of them. A decision with no rejected alternative was
        // not a decision, and one with no reversal condition cannot be revisited
        // by anybody who was not in the room.
        rejected: z.string().min(1),
        revisit_when: z.string().min(1),
      }),
    ),
    blocked_on: BlockedOn,
  })
  .strict();

export const ImplementationPlanningOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    sequence: z.array(
      z.object({
        step: z.string().min(1),
        preconditions: z.array(z.string().min(1)).default([]),
        /** A checkpoint that cannot fail is not a checkpoint. */
        checkpoint: z.string().min(1),
      }),
    ),
    /** After this step a rollback stops being cheap — the thing worth knowing in advance. */
    point_of_no_return: z.string().min(1).nullable(),
    blocked_on: BlockedOn,
  })
  .strict();

export const WriteTestsOutputSchema = z
  .object({
    work_item_id: z.string().min(1),
    tier: z.enum(TEST_TIERS),
    tests: z.array(
      z.object({
        file: z.string().min(1),
        name: z.string().min(1),
        /**
         * The production change that would make this test fail.
         *
         * Required, and it is the whole point. A test with no such change
         * asserts something already guaranteed and passes forever without
         * checking anything — the exact defect mutation testing exists to find,
         * asked for at the moment it is cheapest to answer.
         */
        catches: z.string().min(1),
      }),
    ),
    /** Tiers the author judged impossible to write here, and why. */
    blocked_on: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const OUTPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'schemas/spec-output.schema.json': SpecOutputSchema,
  'schemas/implement-output.schema.json': ImplementOutputSchema,
  'schemas/review-output.schema.json': ReviewOutputSchema,
  'schemas/retrospective-output.schema.json': RetrospectiveOutputSchema,
  'schemas/resolve-conflict-output.schema.json': ResolveConflictOutputSchema,
  'schemas/discovery-output.schema.json': DiscoveryOutputSchema,
  'schemas/decompose-output.schema.json': DecomposeOutputSchema,
  'schemas/plan-story-output.schema.json': PlanStoryOutputSchema,
  'schemas/architecture-output.schema.json': ArchitectureOutputSchema,
  'schemas/implementation-planning-output.schema.json': ImplementationPlanningOutputSchema,
  'schemas/write-tests-output.schema.json': WriteTestsOutputSchema,
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

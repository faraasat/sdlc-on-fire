import { z } from 'zod';
import { AdrIdSchema, WorkItemIdSchema } from './ids.js';

/**
 * Doc-type frontmatter schemas, per contracts/02-object-model.md §4.2–§4.4, §4.7.
 *
 * These are the non-work-item Markdown files that mirror into the `docs` table:
 * specs, change proposals, decision records, and research notes. They were
 * deferred at `P0-OBJ-01` while the walking-skeleton set was built, and are
 * added here to close Q-10.
 *
 * The `doc_type` discriminator matches the `docs.doc_type` CHECK constraint in
 * contracts/01 §3.1 — one vocabulary, enforced in two places.
 */

export const DOC_TYPES = [
  'spec',
  'change',
  'decision',
  'research',
  'risk',
  'archive',
  'constitution',
] as const;
export const DocTypeSchema = z.enum(DOC_TYPES);
export type DocType = z.infer<typeof DocTypeSchema>;

/* ------------------------------------------------------------------------ spec */

export const SPEC_STATUSES = ['draft', 'active', 'archived'] as const;

/**
 * A spec (§4.2).
 *
 * `requirements` are RFC-2119 graded — MUST/SHOULD/MAY — because "the system
 * handles errors" and "the system MUST reject a malformed payload" are different
 * commitments, and only the second can be checked.
 */
/**
 * How acceptance criteria in this spec are written (P1-OBJ-05, FEAT-OBJ-019).
 *
 * Declared rather than inferred, because the three styles are not
 * interchangeable and a reader who guesses wrong misreads the criteria: `bdd`
 * is GIVEN/WHEN/THEN prose, `tdd` names the failing test to write first, and
 * `contract-first` fixes an interface before either. Downstream skills render
 * differently per style, so the tag is what stops a spec being restyled by
 * whoever picks it up next.
 */
export const AC_STYLES = ['bdd', 'tdd', 'contract-first'] as const;
export const AcStyleSchema = z.enum(AC_STYLES);
export type AcStyle = z.infer<typeof AcStyleSchema>;

export const SpecSchema = z.object({
  $schema: z.url(),
  title: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case'),
  status: z.enum(SPEC_STATUSES),
  owner: z.string().min(1).nullable().optional(),
  requirements: z.array(z.string().min(1)).min(1),
  /** Additive; defaults to `bdd`, the style the shipped spec skill emits. */
  ac_style: AcStyleSchema.default('bdd'),
  /**
   * What this spec deliberately does **not** cover (P1-OBJ-06, FEAT-OBJ-021).
   *
   * Required, and required to be non-empty. Scope creep is rarely a decision
   * anyone makes; it is the absence of a decision, and an empty non-goals list
   * is what that absence looks like on disk. Forcing one sentence here is the
   * cheapest scope control available.
   */
  non_goals: z.array(z.string().min(1)).min(1, 'a spec must state at least one non-goal'),
});
export type Spec = z.infer<typeof SpecSchema>;

/* ---------------------------------------------------------------------- change */

export const DELTA_KINDS = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] as const;
export const DeltaKindSchema = z.enum(DELTA_KINDS);

/**
 * Application order for deltas, fixed by the glossary.
 *
 * Renames first so later deltas address the new name; removals before
 * modifications so a modify never targets something about to vanish; additions
 * last so they cannot be clobbered. Applying these in any other order produces
 * a different spec from the same change.
 */
export const DELTA_APPLICATION_ORDER: readonly (typeof DELTA_KINDS)[number][] = [
  'RENAMED',
  'REMOVED',
  'MODIFIED',
  'ADDED',
];

export const SpecDeltaSchema = z.object({
  kind: DeltaKindSchema,
  requirement_id: z.string().min(1),
  text: z.string().min(1),
  /**
   * Style of the amended criterion (P1-OBJ-05). Optional here, unlike on a
   * spec: a delta that does not say inherits the spec's style, and forcing a
   * restatement per delta would invite drift between them.
   */
  ac_style: AcStyleSchema.optional(),
});
export type SpecDelta = z.infer<typeof SpecDeltaSchema>;

export const CHANGE_STATUSES = ['proposed', 'applied', 'archived'] as const;

/** A change proposal (§4.3) — how a referenced spec is amended without editing it in place. */
export const ChangeSchema = z
  .object({
    $schema: z.url(),
    change_id: z.string().min(1),
    spec_ref: z.string().min(1),
    deltas: z.array(SpecDeltaSchema).min(1),
    status: z.enum(CHANGE_STATUSES),
    proposed_by: z.string().min(1),
  })
  .superRefine((change, ctx) => {
    // Two deltas on one requirement make the outcome depend on ordering within
    // a kind, which the application order does not define.
    const seen = new Map<string, number>();
    for (const [index, delta] of change.deltas.entries()) {
      const key = `${delta.kind}:${delta.requirement_id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['deltas', index],
          message: `duplicate ${delta.kind} delta for requirement "${delta.requirement_id}"`,
        });
      }
      seen.set(key, index);
    }
  });
export type Change = z.infer<typeof ChangeSchema>;

/** Sorts deltas into the order the daemon must apply them. Stable within a kind. */
export function orderDeltas(deltas: readonly SpecDelta[]): SpecDelta[] {
  return [...deltas].sort(
    (a, b) => DELTA_APPLICATION_ORDER.indexOf(a.kind) - DELTA_APPLICATION_ORDER.indexOf(b.kind),
  );
}

/* -------------------------------------------------------------------- decision */

export const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'] as const;

/**
 * A decision record (§4.4).
 *
 * An accepted ADR is never edited in place — a reversal is a new ADR with
 * `supersedes` set (ADR-0013's pattern applied to decisions).
 */
export const DecisionSchema = z
  .object({
    $schema: z.url(),
    adr_id: AdrIdSchema,
    title: z.string().min(1),
    status: z.enum(ADR_STATUSES),
    supersedes: AdrIdSchema.nullable().optional(),
    superseded_by: AdrIdSchema.nullable().optional(),
  })
  .superRefine((decision, ctx) => {
    if (decision.supersedes === decision.adr_id && decision.supersedes != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'an ADR cannot supersede itself',
      });
    }
    // A superseded ADR with no pointer leaves a reader at a dead end.
    if (decision.status === 'superseded' && decision.superseded_by == null) {
      ctx.addIssue({
        code: 'custom',
        path: ['superseded_by'],
        message: 'status "superseded" requires superseded_by naming the replacement',
      });
    }
  });
export type Decision = z.infer<typeof DecisionSchema>;

/* -------------------------------------------------------------------- research */

/** A research note (§4.7). `sources` must resolve — an invented citation is worse than none. */
export const ResearchSchema = z.object({
  $schema: z.url(),
  title: z.string().min(1),
  topic: z.string().min(1),
  related_work_items: z.array(WorkItemIdSchema).optional(),
  sources: z.array(z.url()).optional(),
});
export type Research = z.infer<typeof ResearchSchema>;

/* ----------------------------------------------------------------------- union */

/** Every doc-type schema, keyed by its `doc_type`. */
export const DOC_SCHEMAS = {
  spec: SpecSchema,
  change: ChangeSchema,
  decision: DecisionSchema,
  research: ResearchSchema,
} as const;

export type DocSchemaKey = keyof typeof DOC_SCHEMAS;

/** Whether a `doc_type` has a schema yet. `risk`/`archive`/`constitution` are handled elsewhere. */
export function hasDocSchema(docType: string): docType is DocSchemaKey {
  return docType in DOC_SCHEMAS;
}

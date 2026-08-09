import { z } from 'zod';

/**
 * Constitution frontmatter, per contracts/02-object-model.md §4.1.
 *
 * Principles marked `evidence_enforced` additionally compile into `gate_policies`
 * rows — that is what separates a constitution from a README full of good
 * intentions. `gate_ref` names the policy a principle compiles into.
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ConstitutionPrincipleSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /** Whether this principle is mechanically enforced by a gate, or is guidance only. */
  evidence_enforced: z.boolean(),
  gate_ref: z.string().min(1).optional(),
});

export type ConstitutionPrinciple = z.infer<typeof ConstitutionPrincipleSchema>;

export const ConstitutionSchema = z
  .object({
    $schema: z.url(),
    title: z.string().min(1),
    version: z.string().regex(SEMVER, 'version must be semver, e.g. 1.0.0'),
    principles: z.array(ConstitutionPrincipleSchema).min(1),
    amended_at: z.iso.datetime().optional(),
  })
  .superRefine((constitution, ctx) => {
    const seen = new Set<string>();
    for (const [index, principle] of constitution.principles.entries()) {
      if (seen.has(principle.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['principles', index, 'id'],
          message: `duplicate principle id "${principle.id}" — ids are the stable handle gates reference`,
        });
      }
      seen.add(principle.id);

      // An enforced principle with no gate to enforce it is the exact failure
      // mode the constitution exists to prevent: a claim with nothing behind it.
      if (principle.evidence_enforced && principle.gate_ref === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['principles', index, 'gate_ref'],
          message: `principle "${principle.id}" is evidence_enforced but names no gate_ref`,
        });
      }
    }
  });

export type Constitution = z.infer<typeof ConstitutionSchema>;

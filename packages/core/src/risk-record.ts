import { z } from 'zod';
import { RISK_SURFACES, type RiskSurface, type SurfaceFinding } from './risk-surface.js';

/**
 * The risk artifact (P6-WRITEPATH-02; FEAT-OBJ-005, FEAT-SEC-005).
 *
 * `riskCardsFor` has produced `RiskCard[]` since P2-SEC-03, and `sdlc risk`
 * has printed "2 risk card(s) to create:" ever since. **Nothing created them.**
 * Seventh read path with no writer this phase, and the tell was in the output
 * all along: a line that says what somebody ought to do next is what a feature
 * looks like when the last step was never built.
 *
 * **A risk is not a work item.** Contract 02 §2.1 says every Kanban card is one
 * of five kinds, and adding a sixth was the obvious move and the wrong one: a
 * risk is not work to be done — its *mitigation* is, and that is a different
 * object with a different lifecycle. A risk has three states and no ladder, no
 * preset, no gates. So it lives beside `_inbox/` and `_insertions/` under the
 * same leading-underscore convention contract 06 already uses for records that
 * are not work-item containers.
 *
 * **Severity is derived, never assigned.** Every surface here is high-risk by
 * definition — that is what put it in `RISK_SURFACES` — so a model asked to
 * grade one would be inventing a distinction. The table below grades by
 * *reversibility* instead, states a reason per surface, and is total over the
 * vocabulary (ADR-0040).
 *
 * **Nothing writes a mitigation.** The generated record states the surface and
 * the evidence and stops, exactly as `riskCardsFor` already did: writing "this
 * looks fine" into an auto-generated card puts a conclusion nobody reached in
 * front of the person whose job is to reach it.
 */

export const RISK_STATUSES = ['open', 'mitigated', 'accepted'] as const;
export const RiskStatusSchema = z.enum(RISK_STATUSES);
export type RiskStatus = z.infer<typeof RiskStatusSchema>;

export const RISK_SEVERITIES = ['medium', 'high'] as const;
export const RiskSeveritySchema = z.enum(RISK_SEVERITIES);
export type RiskSeverity = z.infer<typeof RiskSeveritySchema>;

/**
 * Severity by surface, with the reason stated.
 *
 * The axis is **how reversible the damage is**, not how likely it is. Likelihood
 * is a property of the specific change and nothing here can see it;
 * reversibility is a property of the surface and is the same every time. There
 * is no `low`: a surface that could be low is a surface that should not have
 * been in `RISK_SURFACES`.
 */
export const RISK_SEVERITY: Readonly<
  Record<RiskSurface, { readonly severity: RiskSeverity; readonly because: string }>
> = {
  auth: { severity: 'high', because: 'a wrong answer here is somebody else being you' },
  payments: { severity: 'high', because: 'money moves once and comes back by negotiation' },
  migrations: {
    severity: 'high',
    because: 'data that is gone is gone; a rollback is not a restore',
  },
  secrets: {
    severity: 'high',
    because: 'a leaked credential is leaked for as long as it is valid',
  },
  permissions: { severity: 'high', because: 'a widened grant is invisible until it is used' },
  deployment: { severity: 'high', because: 'it changes what is running for everyone at once' },
  infra: { severity: 'high', because: 'the blast radius is the environment, not the request' },
  uploads: { severity: 'medium', because: 'bounded by what the handler will accept and store' },
  'external-api': {
    severity: 'medium',
    because: 'bounded by the credential and the data actually sent',
  },
};

export const RiskRecordSchema = z
  .strictObject({
    id: z.string().regex(/^RISK-\d{3,}$/, 'risk ids are RISK-NNN, zero-padded and never reused'),
    /** The work item whose change raised it. A risk with no source is a worry. */
    work_item_id: z.string().min(1),
    surface: z.enum(RISK_SURFACES),
    severity: RiskSeveritySchema,
    /** What matched, per file — the evidence, so the record can be argued with. */
    evidence: z
      .array(z.strictObject({ path: z.string().min(1), matched: z.string().min(1) }))
      .min(1),
    status: RiskStatusSchema,
    /** Written by a person. Never generated. */
    mitigation: z.string().min(1).nullable(),
    /** Why it was accepted as-is. Also written by a person. */
    accepted_because: z.string().min(1).nullable(),
    created_at: z.iso.datetime(),
  })
  .superRefine((record, ctx) => {
    // A status that outruns its justification is the failure this artifact
    // exists to prevent: "mitigated" with nothing written down is a risk that
    // has been closed rather than handled, and it reads identically to one that
    // was.
    if (record.status === 'mitigated' && record.mitigation === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['mitigation'],
        message: 'a mitigated risk says what mitigated it',
      });
    }
    if (record.status === 'accepted' && record.accepted_because === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['accepted_because'],
        message: 'an accepted risk says who accepted it and why',
      });
    }
  });
export type RiskRecord = z.infer<typeof RiskRecordSchema>;

export function riskRecordId(sequence: number): string {
  return `RISK-${String(sequence).padStart(3, '0')}`;
}

/**
 * The records a set of findings earns, one per surface.
 *
 * One per surface rather than one per file, matching `riskCardsFor`: "this
 * change touches payments" is the reviewable unit, and nine records for nine
 * payment files is a backlog nobody reads.
 */
export function riskRecordsFor(
  findings: readonly SurfaceFinding[],
  workItemId: string,
  firstSequence: number,
  createdAt: string,
): readonly RiskRecord[] {
  const bySurface = new Map<RiskSurface, SurfaceFinding[]>();
  for (const finding of findings) {
    const existing = bySurface.get(finding.surface);
    if (existing === undefined) bySurface.set(finding.surface, [finding]);
    else existing.push(finding);
  }

  let sequence = firstSequence;
  return [...bySurface.entries()].map(([surface, group]) =>
    RiskRecordSchema.parse({
      id: riskRecordId(sequence++),
      work_item_id: workItemId,
      surface,
      severity: RISK_SEVERITY[surface].severity,
      evidence: group.map((finding) => ({ path: finding.path, matched: finding.evidence })),
      status: 'open',
      mitigation: null,
      accepted_because: null,
      created_at: createdAt,
    }),
  );
}

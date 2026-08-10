import type { Constitution, ConstitutionPrinciple } from '@sdlc-on-fire/core';
import { GatePolicySchema, type GatePolicy } from './evaluate-gate.js';

/**
 * Constitution → gate policies (P1-LIFE-03, ADR-0005).
 *
 * This is what separates a constitution from a README full of good intentions:
 * a principle marked `evidence_enforced` compiles into a policy that actually
 * blocks, and one that is not stays advisory. The compile step is where that
 * distinction becomes mechanical.
 *
 * v0.1 scope (mvp-slice): the single MVP gate — tests and typecheck must pass.
 */

/**
 * Evidence kinds a principle can demand, keyed by the token it names.
 *
 * A closed vocabulary on purpose: a principle asking for evidence nobody can
 * produce is a principle that blocks forever, so an unknown demand is reported
 * rather than compiled into an unsatisfiable policy.
 */
export const PRINCIPLE_EVIDENCE_VOCABULARY = {
  tests: 'test',
  typecheck: 'typecheck',
  build: 'build',
} as const;

export type PrincipleEvidenceToken = keyof typeof PRINCIPLE_EVIDENCE_VOCABULARY;

export interface SyncImpact {
  /** Policies that would be created or changed by this compile. */
  readonly compiled: readonly string[];
  /** Principles carrying no enforceable demand — advisory, and said so. */
  readonly advisory: readonly string[];
  /** Principles that ask for something the vocabulary cannot express. */
  readonly unsatisfiable: readonly { principleId: string; reason: string }[];
}

export interface CompiledConstitution {
  readonly policies: readonly GatePolicy[];
  readonly impact: SyncImpact;
}

/** Evidence kinds a principle's statement demands, by vocabulary token. */
export function demandedKinds(principle: ConstitutionPrinciple): string[] {
  const statement = principle.statement.toLowerCase();
  return Object.entries(PRINCIPLE_EVIDENCE_VOCABULARY)
    .filter(([token]) => statement.includes(token))
    .map(([, kind]) => kind);
}

/**
 * Compiles a constitution into gate policies, with a sync-impact report.
 *
 * The report is the deliverable as much as the policies are: a user editing
 * their constitution needs to see *what changed about enforcement*, not just
 * that the file saved. A principle that quietly compiles to nothing is the
 * failure mode this surfaces.
 */
export function compileConstitution(constitution: Constitution): CompiledConstitution {
  const policies: GatePolicy[] = [];
  const compiled: string[] = [];
  const advisory: string[] = [];
  const unsatisfiable: { principleId: string; reason: string }[] = [];

  for (const principle of constitution.principles) {
    if (!principle.evidence_enforced) {
      advisory.push(principle.id);
      continue;
    }

    const kinds = demandedKinds(principle);
    if (kinds.length === 0) {
      // Marked enforced but naming nothing checkable: compiling this to an empty
      // policy would make it pass trivially, which is worse than reporting it.
      unsatisfiable.push({
        principleId: principle.id,
        reason:
          'marked evidence_enforced but names no recognised evidence ' +
          `(known: ${Object.keys(PRINCIPLE_EVIDENCE_VOCABULARY).join(', ')})`,
      });
      continue;
    }

    policies.push(
      GatePolicySchema.parse({
        name: principle.gate_ref ?? principle.id,
        evidence: kinds.map((kind) => ({ kind, required: true })),
      }),
    );
    compiled.push(principle.id);
  }

  return { policies, impact: { compiled, advisory, unsatisfiable } };
}

/** Human-readable sync-impact report. `--json` callers use the structured form. */
export function formatSyncImpact(impact: SyncImpact): string {
  const lines = [
    `enforced:    ${impact.compiled.length === 0 ? '(none)' : impact.compiled.join(', ')}`,
    `advisory:    ${impact.advisory.length === 0 ? '(none)' : impact.advisory.join(', ')}`,
  ];
  for (const problem of impact.unsatisfiable) {
    lines.push(`UNSATISFIABLE ${problem.principleId}: ${problem.reason}`);
  }
  return lines.join('\n');
}

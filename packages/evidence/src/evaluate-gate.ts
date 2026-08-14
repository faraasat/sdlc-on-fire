import { z } from 'zod';
import {
  EVIDENCE_KINDS,
  isExpired,
  isGatingEvidence,
  isStale,
  type EvidenceEnvelope,
  type EvidenceKind,
} from '@sdlc-on-fire/core';

/**
 * `evaluateGate` — contracts/03 §5.
 *
 * A **pure function**. All I/O — running tests, fetching CI status, computing
 * HEAD — happens upstream; this only reads its arguments. That purity is what
 * makes a gate result replayable from `gate_evidence` + `gates.gate_result`
 * alone, which is the difference between an audit trail and a claim about one.
 */

export const GateEvidenceRequirementSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  required: z.boolean().default(true),
  /**
   * When true, an expired envelope counts as **missing** rather than merely
   * low-confidence — "run it again" and "it failed" are different remediations.
   */
  require_fresh: z.boolean().default(false),
});

export const GatePolicySchema = z.object({
  name: z.string().min(1),
  evidence: z.array(GateEvidenceRequirementSchema).default([]),
  test_quality: z
    .object({
      /** ADR-0037 signals. Empty in v0.1 — see the honest-empty note below. */
      required_signals: z.array(z.enum(EVIDENCE_KINDS)).default([]),
    })
    .prefault({}),
  approvals: z
    .object({
      required_roles: z.array(z.string().min(1)).default([]),
      min_approvals: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
  /**
   * Roles permitted to record an override (contract 03 §4).
   *
   * Defaults to **empty**, and empty means *no override path at all* rather
   * than "unrestricted" — the strict preset uses `overridable_by: []` to close
   * the door, and reading an omitted field as open would invert the strictest
   * policy in the set.
   */
  overridable_by: z.array(z.string().min(1)).default([]),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;

export interface Approval {
  readonly actorId: string;
  readonly actorKind: 'human' | 'agent';
  readonly roleId?: string | null | undefined;
  readonly decision: 'approve' | 'request-changes' | 'override';
  readonly revokedAt?: string | null | undefined;
}

export interface GateContext {
  readonly currentHeadSha: string;
  readonly currentDirtyTreeHash?: string | undefined;
  readonly now: Date;
}

export interface GateVerdict {
  readonly pass: boolean;
  /** No qualifying envelope found — remediation is "run the check". */
  readonly missing: readonly string[];
  /** A qualifying envelope says the check did not pass — remediation is "fix the code". */
  readonly failures: readonly string[];
  /**
   * The verifier declined to conclude — remediation is "give it more context"
   * (P1-GATE-04, ADR-0019).
   *
   * Distinct from `failures` on purpose. "Nothing could check this claim" and
   * "this claim is wrong" need different human responses, and a reviewer who
   * sees them in one bucket learns to treat both as noise.
   */
  readonly abstained: readonly string[];
}

/**
 * Whether an envelope still describes the tree being gated.
 *
 * The staleness re-check is one of the two guarantees contract §7 marks
 * explicitly non-deferrable: evidence from a different commit is not evidence
 * about this one.
 */
export function isCurrent(envelope: EvidenceEnvelope, ctx: GateContext): boolean {
  return !isStale(envelope, {
    git_sha: ctx.currentHeadSha,
    dirty_tree_hash: ctx.currentDirtyTreeHash,
  });
}

function mostRecent(envelopes: readonly EvidenceEnvelope[]): EvidenceEnvelope | undefined {
  return [...envelopes].sort((a, b) => Date.parse(b.produced_at) - Date.parse(a.produced_at))[0];
}

/**
 * The part of a knowledge-claim bundle this gate reads.
 *
 * Structural, not an import of the full {@link ClaimBundle}: `evaluateGate` is
 * pure and reads envelope payloads, which arrive as `unknown` from the DB. It
 * needs the two counts and nothing else.
 */
interface ClaimBundleShape {
  readonly unsupported: readonly unknown[];
  readonly abstained: readonly unknown[];
}

function payloadOk(payload: unknown): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
  );
}

/**
 * Approvals that count.
 *
 * **Agents are actors, never approvers** (architecture §5). An agent's approval
 * is filtered out here as well as by the DB trigger — belt and braces on the
 * invariant, because a bug in one layer must not be sufficient to defeat it.
 */
export function countingApprovals(approvals: readonly Approval[], policy: GatePolicy): Approval[] {
  return approvals.filter(
    (approval) =>
      approval.actorKind !== 'agent' &&
      approval.decision === 'approve' &&
      (approval.revokedAt === null || approval.revokedAt === undefined) &&
      (policy.approvals.required_roles.length === 0 ||
        (approval.roleId !== null &&
          approval.roleId !== undefined &&
          policy.approvals.required_roles.includes(approval.roleId))),
  );
}

/**
 * Evaluates a gate.
 *
 * Three-way per requirement, never collapsed to a binary: `missing` means run
 * the check, `failures` means fix the code, `abstained` means the verifier
 * declined to conclude. Collapsing them would tell a user something failed when
 * in fact nothing ran.
 */
export function evaluateGate(
  policy: GatePolicy,
  evidenceBundle: readonly EvidenceEnvelope[],
  approvals: readonly Approval[],
  ctx: GateContext,
): GateVerdict {
  const missing: string[] = [];
  const failures: string[] = [];
  const abstained: string[] = [];

  for (const requirement of policy.evidence) {
    const candidates = evidenceBundle
      .filter((envelope) => envelope.kind === requirement.kind)
      // Structural exclusion, not a policy toggle: agent-claim evidence carries
      // zero weight regardless of what any policy says (ADR-0030).
      .filter(isGatingEvidence)
      .filter((envelope) => isCurrent(envelope, ctx))
      .filter((envelope) => !(requirement.require_fresh && isExpired(envelope, ctx.now)));

    if (candidates.length === 0) {
      if (requirement.required) missing.push(requirement.kind);
      continue;
    }

    const latest = mostRecent(candidates);
    if (latest === undefined) continue;

    // A knowledge-claim bundle reports two failing modes, and flattening them to
    // `ok: false` would be the collapse ADR-0019 rejects by name.
    if (requirement.kind === 'knowledge-claim') {
      const bundle = latest.payload as Partial<ClaimBundleShape> | undefined;
      const unsupported = bundle?.unsupported ?? [];
      const abstainedClaims = bundle?.abstained ?? [];
      if (unsupported.length > 0) {
        failures.push(
          `knowledge-claim: ${String(unsupported.length)} claim(s) cite what does not support them`,
        );
      }
      if (abstainedClaims.length > 0) {
        abstained.push(
          `knowledge-claim: ${String(abstainedClaims.length)} claim(s) could not be verified`,
        );
      }
      continue;
    }

    if (!payloadOk(latest.payload)) {
      failures.push(`${requirement.kind} failing`);
    }
  }

  // ADR-0037 test-quality signals. Empty in v0.1, and honestly so: there is no
  // independent-subagent infrastructure yet to compute a same-session-exclusion
  // check against, and a fake enforcement would be worse than an absent one.
  for (const signal of policy.test_quality.required_signals) {
    const independent = evidenceBundle
      .filter((envelope) => envelope.kind === signal)
      .filter((envelope) => envelope.producer === 'daemon' || envelope.producer === 'ci')
      .filter((envelope) => isCurrent(envelope, ctx));

    if (independent.length === 0) missing.push(signal);
    else if (!payloadOk(mostRecent(independent)?.payload)) failures.push(`${signal} failing`);
  }

  const counted = countingApprovals(approvals, policy);

  // Each required role separately, then the floor (P3-RBAC-03). These were one
  // check: `required_roles` filtered the approvals and the survivors were
  // compared against `min_approvals`, so `["eng-lead","security"]` with a floor
  // of 1 passed on one eng-lead approval and no security review — and a policy
  // naming a role with a floor of 0 passed on nothing at all. Contract 03 §4
  // says each named role must *each* have one, and a security sign-off a peer
  // can satisfy is not a security sign-off.
  for (const role of policy.approvals.required_roles) {
    if (!counted.some((approval) => approval.roleId === role)) {
      missing.push(`approval from ${role}`);
    }
  }
  if (counted.length < policy.approvals.min_approvals) {
    missing.push(`approvals (${counted.length}/${policy.approvals.min_approvals})`);
  }

  return {
    pass: missing.length === 0 && failures.length === 0 && abstained.length === 0,
    missing,
    failures,
    abstained,
  };
}

/** The v0.1 walking-skeleton policy (contracts/03 §7): three kinds, no approvals. */
export function defaultV01Policy(name = 'standard'): GatePolicy {
  return GatePolicySchema.parse({
    name,
    evidence: (['test', 'typecheck', 'build'] satisfies EvidenceKind[]).map((kind) => ({
      kind,
      required: true,
    })),
  });
}

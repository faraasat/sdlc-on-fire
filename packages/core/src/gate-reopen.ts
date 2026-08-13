/**
 * Selective gate re-open, and the one legitimate write to a finished item
 * (P2-INS-02, `.research/11 §1`, contract 02 §8 open question 2).
 *
 * Two halves of one question, kept in one module because they are the same
 * question asked twice.
 *
 * **First half — which gates flip back.** A hard insertion (P2-INS-01) changes
 * what a container contains, so evidence gathered before it is not
 * automatically evidence about what exists after it. Re-opening *every* gate is
 * correct and so expensive nobody does it; re-opening none is cheap and wrong.
 * The middle is to re-open the gates whose covered files were actually touched
 * — which requires knowing what each gate covers, and that is a declaration,
 * not something to infer. **A requirement with no declared coverage re-opens.**
 * It cannot be shown unaffected, and reading "we do not know" as "unaffected"
 * is the substitution this product refuses everywhere else. Selective re-open
 * is therefore an optimisation you *earn* by declaring coverage, never a
 * default that quietly narrows what gets re-checked.
 *
 * **Second half — how the writer tells the two writes apart.** The typed
 * writer refuses in-place edits to terminal items (ADR-0013), and a gate
 * re-open is the one write that legitimately touches one. Contract 02 §8 left
 * the algorithm open; it is settled here, and the previous placeholder — an
 * `allowTerminal: boolean` — is exactly what it must not be. A bypass reachable
 * by passing `true` is not a guard; it is a comment.
 *
 * The answer is that the write must be *derivable*, not asserted:
 *
 *   1. An **approved** insertion record names it (an unapproved insertion is a
 *      request, not an authority),
 *   2. the item is inside **that insertion's** blast radius, and
 *   3. the write touches only operational fields and leaves the body
 *      byte-identical.
 *
 * Condition 3 is the one that answers BMAD #1930 (`.research/11 §2`), where
 * correct-course rewrites a completed story's acceptance criteria in place and
 * silently breaks the link between what the code was reviewed against and what
 * the story now says. A gate re-open changes *gate state*. It has no business
 * touching the text the finished work was reviewed against, and here it
 * structurally cannot.
 */

import { regressionScopeFor } from './regression-scope.js';
import type { ChangedFile } from './risk-surface.js';

/** What a gate requirement covers on disk. Declared, never inferred. */
export interface GateCoverage {
  readonly requirementId: string;
  /** Path prefixes. `src/auth/` covers everything beneath it. */
  readonly paths: readonly string[];
}

export interface ReopenDecision {
  readonly requirementId: string;
  readonly reopen: boolean;
  readonly reason: string;
}

export interface ReopenPlan {
  readonly decisions: readonly ReopenDecision[];
  readonly reopened: readonly string[];
  readonly kept: readonly string[];
}

function covers(coverage: GateCoverage, changedPaths: readonly string[]): string | null {
  for (const prefix of coverage.paths) {
    const hit = changedPaths.find((p) => p === prefix || p.startsWith(prefix));
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Which gate requirements a change re-opens.
 *
 * `workType` and `changed` go through `regressionScopeFor` rather than being
 * re-decided here — `migrate`, and any change touching auth/payments/
 * migrations, re-opens everything regardless of declared coverage, because
 * those are precisely the changes whose blast radius is not the files they
 * touched (P2-LIFE-02).
 */
export function planReopen(
  requirements: readonly string[],
  changed: readonly ChangedFile[],
  coverage: readonly GateCoverage[],
  workType = 'feature',
): ReopenPlan {
  const regression = regressionScopeFor(workType, changed);
  const changedPaths = changed.map((file) => file.path);
  const byRequirement = new Map(coverage.map((entry) => [entry.requirementId, entry]));

  const decisions = requirements.map((requirementId): ReopenDecision => {
    if (regression.scope === 'full') {
      return { requirementId, reopen: true, reason: regression.reason };
    }

    const declared = byRequirement.get(requirementId);
    if (declared === undefined || declared.paths.length === 0) {
      // The load-bearing default. An undeclared requirement is not a
      // requirement known to be unaffected — it is one nobody described, and
      // the two must not produce the same outcome.
      return {
        requirementId,
        reopen: true,
        reason: 'no declared coverage — a requirement nobody scoped cannot be shown unaffected',
      };
    }

    const hit = covers(declared, changedPaths);
    return hit === null
      ? { requirementId, reopen: false, reason: 'nothing it covers was touched' }
      : { requirementId, reopen: true, reason: `covers ${hit}, which this change touched` };
  });

  return {
    decisions,
    reopened: decisions.filter((d) => d.reopen).map((d) => d.requirementId),
    kept: decisions.filter((d) => !d.reopen).map((d) => d.requirementId),
  };
}

/**
 * Frontmatter fields a gate re-open may change.
 *
 * An **allowlist**, and the direction matters more than the contents: a field
 * added to the schema tomorrow is protected by default rather than editable by
 * default. A denylist would mean every new field is writable on a finished item
 * until somebody remembers to add it, which is a guard that decays.
 *
 * `status` is here because contract 06 §4 makes it a projection of
 * `lifecycle_state` that the writer refreshes — leaving it out would make every
 * legitimate re-open fail on a field the writer itself maintains.
 */
export const REOPENABLE_FIELDS: ReadonlySet<string> = new Set([
  'lifecycle_state',
  'status',
  'updated_at',
  'claimed_by',
  'claim_expires_at',
  'branch',
  'assignee',
]);

export interface PreservationResult {
  readonly ok: boolean;
  /** Every protected field the write would have changed. */
  readonly changed: readonly string[];
  readonly bodyChanged: boolean;
}

/**
 * Whether a write leaves everything a reviewer signed off on untouched.
 *
 * Reports **all** offending fields rather than the first: a caller told only
 * about `acceptance_criteria` fixes that, retries, and is told about
 * `spec_ref`, which teaches them the check is a nuisance rather than a rule.
 */
export function contentPreserved(
  before: Readonly<Record<string, unknown>>,
  beforeBody: string,
  after: Readonly<Record<string, unknown>>,
  afterBody: string,
): PreservationResult {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (REOPENABLE_FIELDS.has(key)) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changed.push(key);
    }
  }
  changed.sort();

  const bodyChanged = beforeBody !== afterBody;
  return { ok: changed.length === 0 && !bodyChanged, changed, bodyChanged };
}

/**
 * Grounds for writing a terminal work item.
 *
 * **There are exactly two, and they are a closed union rather than a flag.**
 * That is the shape the invariant needs: a caller does not assert permission,
 * it states *which* recognised ground it is standing on, and every field of
 * each ground is something a checker can verify against something on disk.
 *
 * - `insertion` — an approved hard insertion (P2-INS-01) whose blast radius
 *   reaches this item. Verified against `kanban/_insertions/INSERT-NNN.md`.
 * - `retraction` — an attestation came back `unsupported`: the item claims a
 *   terminal stage its own evidence never supported (`sdlc reopen`). Verified
 *   against the attestation, not against the caller's opinion of it.
 *
 * A third ground can be added later; what cannot be added is "the caller said
 * so", because there is no member of this union that means it.
 */
export type TerminalWriteGrounds =
  | {
      readonly kind: 'insertion';
      readonly insertionId: string;
      readonly insertionState: string;
      /** Work items the insertion's blast radius reached. */
      readonly blastRadius: readonly string[];
      /** The item being written. */
      readonly itemId: string;
    }
  | {
      readonly kind: 'retraction';
      readonly itemId: string;
      /** The attestation verdict. Only `unsupported` is grounds. */
      readonly attestation: string;
    };

export interface ReopenVerdict {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

/**
 * Whether a write to a terminal work item stands on recognised grounds.
 *
 * Returns the reasons it does not, all of them, so the writer's error names the
 * whole gap rather than the first thing checked.
 */
export function authorizeTerminalWrite(
  grounds: TerminalWriteGrounds,
  preservation: PreservationResult,
): ReopenVerdict {
  const reasons: string[] = [];

  if (grounds.kind === 'insertion') {
    if (grounds.insertionState !== 'approved') {
      reasons.push(
        `${grounds.insertionId} is ${grounds.insertionState}, not approved — a proposed insertion is a request, not an authority to edit finished work`,
      );
    }

    if (!grounds.blastRadius.includes(grounds.itemId)) {
      // Without this, one approved insertion anywhere authorises editing every
      // terminal item in the repository.
      reasons.push(
        `${grounds.itemId} is not in ${grounds.insertionId}'s blast radius — that insertion does not reach this item`,
      );
    }
  } else if (grounds.attestation !== 'unsupported') {
    // `supported` means the claim was true; `stale` means re-run the check.
    // Retracting on either would be reopening honest work, which is how a
    // retraction stops being read as a serious finding.
    reasons.push(
      `${grounds.itemId}'s attestation is "${grounds.attestation}", not "unsupported" — only a claim its own evidence contradicts may be retracted`,
    );
  }

  if (preservation.bodyChanged) {
    reasons.push(
      'the body changed — a gate re-open changes gate state, never the text the finished work was reviewed against (ADR-0013, BMAD #1930)',
    );
  }

  if (preservation.changed.length > 0) {
    reasons.push(
      `these fields are not re-openable: ${preservation.changed.join(', ')} — supersede or correct the item instead (ADR-0013)`,
    );
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * The audit section a re-open appends to the insertion record that authorised
 * it.
 *
 * Appended to `INSERT-NNN.md` rather than written somewhere new, because the
 * question being asked later is always "what did this insertion do" — and an
 * approval in one file with its consequences in another is two files nobody
 * reads together.
 *
 * **Gates left standing are listed as well as gates re-opened.** A record
 * naming only what re-opened cannot distinguish a gate deliberately kept from
 * a gate nobody considered, and the reasoning for keeping one is the part
 * worth auditing: it is the claim that evidence gathered before the insertion
 * still describes the tree after it.
 */
export function reopenAuditEntry(
  plan: ReopenPlan,
  changedPaths: readonly string[],
  at: string,
): string {
  const lines = ['', `## Gate re-open — ${at}`, ''];

  lines.push(
    changedPaths.length === 0 ? 'No files changed.' : `Changed: ${changedPaths.join(', ')}`,
    '',
  );

  for (const decision of plan.decisions) {
    lines.push(
      `- ${decision.reopen ? '**re-opened**' : 'left standing'} \`${decision.requirementId}\` — ${decision.reason}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function formatReopenPlan(plan: ReopenPlan): string {
  const lines: string[] = [];
  for (const decision of plan.decisions) {
    lines.push(`  ${decision.reopen ? '↻' : '·'} ${decision.requirementId} — ${decision.reason}`);
  }
  lines.push(
    '',
    `${String(plan.reopened.length)} gate(s) re-opened, ${String(plan.kept.length)} left standing.`,
  );
  return lines.join('\n');
}

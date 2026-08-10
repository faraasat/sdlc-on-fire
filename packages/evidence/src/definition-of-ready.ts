import type { Preset } from '@sdlc-on-fire/core';

/**
 * The Definition-of-Ready gate (P1-GATE-07, ADR-0031).
 *
 * The product had designed exit criteria exhaustively — the evidence gate,
 * `gate_policies`, the knowledge-claim gate — and never designed entry criteria.
 * The object model starts at "a spec exists"; nothing asked whether that spec
 * was well-formed enough to hand to an implementing agent. An under-specified
 * card costs a whole agent run to discover mid-execution that the acceptance
 * criteria were vague, and the agent quietly fills the gaps with its own
 * defaults on the way.
 *
 * **This gate is soft, and the asymmetry is the decision.** "Ready" means
 * understood; "done" means verifiable. Holding readiness to the evidence gate's
 * bar would either block work on a judgment call a machine cannot make, or —
 * more likely — become a warning everyone learns to click through. So findings
 * are `warn` by default, overridable, and every override is *recorded*: ADR-0031
 * names rubber-stamping as the failure mode to instrument against, and an
 * override nobody counts is an override nobody notices.
 *
 * Checks are deterministic (ADR-0040). Nothing here asks a model whether a spec
 * reads as ready — it checks for structures whose absence is unambiguous.
 */

/** How strongly a finding blocks. `block` exists for preset escalation, not as the default. */
export type ReadinessSeverity = 'warn' | 'block';

export interface ReadinessFinding {
  readonly check: string;
  readonly severity: ReadinessSeverity;
  readonly detail: string;
  /** What to do about it, in the finding rather than in documentation. */
  readonly remedy: string;
}

export interface ReadinessInput {
  readonly id: string;
  readonly preset: Preset;
  readonly acceptanceCriteria: readonly string[];
  readonly nonGoals: readonly string[];
  /** Ids this item declares it is blocked by. */
  readonly blockedBy: readonly string[];
  /** Of those, the ones that have actually finished. */
  readonly resolvedBlockers: readonly string[];
  /** Blockers the author explicitly accepted as unresolved, with a reason. */
  readonly acceptedBlockers?: Readonly<Record<string, string>> | undefined;
  /** Doc references the card makes, and whether each resolves to a live doc. */
  readonly references?: readonly { readonly ref: string; readonly resolves: boolean }[] | undefined;
  /**
   * Force blocking regardless of preset — the `definition_of_ready_gate`
   * capability (ADR-0067).
   *
   * A workspace that turns this on has said it wants entry criteria enforced,
   * which is a different statement from choosing the strict preset. Both reach
   * the same place; neither implies the other.
   */
  readonly enforce?: boolean | undefined;
}

export interface ReadinessVerdict {
  readonly workItemId: string;
  readonly ready: boolean;
  readonly findings: readonly ReadinessFinding[];
  /** True when something would block outright — only reachable under `strict`. */
  readonly blocked: boolean;
}

/** RFC-2119 keywords. A criterion using none states a wish rather than a requirement. */
const RFC_2119 =
  /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|RECOMMENDED|MAY|OPTIONAL)\b/;

const BDD = /\bGIVEN\b[\s\S]*\bWHEN\b[\s\S]*\bTHEN\b/i;

/**
 * Whether a criterion is scored — machine-parseable as a requirement.
 *
 * Either an RFC-2119 keyword *in capitals* or the GIVEN/WHEN/THEN structure.
 * Capitals matter: RFC 2119 says so, and a lowercase "should" is ordinary
 * English that appears in half of all prose. Accepting it would score every
 * sentence and make the check report success on anything.
 */
export function isScoredCriterion(text: string): boolean {
  return RFC_2119.test(text) || BDD.test(text);
}

/** Presets where a readiness finding blocks rather than warns. */
const BLOCKING_PRESETS: readonly Preset[] = ['strict'];

/**
 * Evaluates readiness.
 *
 * Pure, like `evaluateGate` — all I/O (reading the card, resolving blockers,
 * checking that a doc reference exists) happens upstream. That is what makes a
 * verdict reproducible from what was recorded rather than a claim about it.
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessVerdict {
  const severity: ReadinessSeverity =
    input.enforce === true || BLOCKING_PRESETS.includes(input.preset) ? 'block' : 'warn';
  const findings: ReadinessFinding[] = [];

  if (input.acceptanceCriteria.length === 0) {
    findings.push({
      check: 'acceptance-criteria-present',
      severity,
      detail: 'no acceptance criteria',
      remedy: 'state at least one criterion the work has to satisfy',
    });
  } else {
    const unscored = input.acceptanceCriteria.filter((text) => !isScoredCriterion(text));
    if (unscored.length > 0) {
      findings.push({
        check: 'acceptance-criteria-scored',
        severity,
        detail: `${String(unscored.length)} of ${String(input.acceptanceCriteria.length)} criteria state a wish rather than a requirement: ${unscored
          .map((text) => `"${text.slice(0, 60)}"`)
          .join(', ')}`,
        remedy: 'use an RFC-2119 keyword in capitals (MUST, SHOULD, MAY) or GIVEN/WHEN/THEN',
      });
    }
  }

  if (input.nonGoals.length === 0) {
    findings.push({
      check: 'non-goals-present',
      severity,
      // Scope creep is rarely a decision anyone makes; it is the absence of one,
      // and an empty non-goals list is what that absence looks like on disk.
      detail: 'no non-goals — nothing says what this deliberately does not cover',
      remedy: 'add one sentence naming something out of scope',
    });
  }

  const resolved = new Set(input.resolvedBlockers);
  const accepted = input.acceptedBlockers ?? {};
  const outstanding = input.blockedBy.filter(
    (id) => !resolved.has(id) && (accepted[id] ?? '').trim() === '',
  );
  if (outstanding.length > 0) {
    findings.push({
      check: 'blockers-resolved',
      severity,
      detail: `blocked by ${outstanding.join(', ')}, neither finished nor explicitly accepted`,
      // "Accepted" needs a reason, not just a flag. A boolean override is one
      // keystroke and carries no information for the person who finds it later.
      remedy: 'finish the blocker, or accept it with a reason recorded on the card',
    });
  }

  const dangling = (input.references ?? []).filter((reference) => !reference.resolves);
  if (dangling.length > 0) {
    findings.push({
      check: 'references-resolve',
      severity,
      detail: `${String(dangling.length)} reference(s) point at nothing: ${dangling
        .map((reference) => reference.ref)
        .join(', ')}`,
      remedy: 'fix the path, or drop the reference — an agent will read it as context that exists',
    });
  }

  return {
    workItemId: input.id,
    ready: findings.length === 0,
    findings,
    blocked: findings.some((finding) => finding.severity === 'block'),
  };
}

export interface ReadinessOverride {
  readonly workItemId: string;
  readonly actor: string;
  readonly reason: string;
  readonly findings: readonly string[];
}

/**
 * Whether an override is admissible.
 *
 * A reason is mandatory and has to be more than a gesture. ADR-0031 warns that
 * a soft gate becomes a rubber stamp when overriding is too easy, so the
 * cheapest possible override — an empty string, or "ok" — is refused. This does
 * not make the gate hard; it makes the override *cost one sentence*, which is
 * the difference between a decision and a reflex.
 */
export function isAdmissibleOverride(override: ReadinessOverride): boolean {
  return override.reason.trim().split(/\s+/).filter(Boolean).length >= 4;
}

/** Human-readable report, remedies included — a warning without one is noise. */
export function formatReadiness(verdict: ReadinessVerdict): string {
  if (verdict.ready) return `✅ ${verdict.workItemId} is ready to start.`;
  const lines = [
    `${verdict.blocked ? '❌' : '⚠️ '} ${verdict.workItemId} is not ready — ${String(verdict.findings.length)} finding(s):`,
    '',
  ];
  for (const finding of verdict.findings) {
    lines.push(
      `  ${finding.severity === 'block' ? '❌' : '⚠️ '} ${finding.check}: ${finding.detail}`,
    );
    lines.push(`     → ${finding.remedy}`);
  }
  lines.push('');
  lines.push(
    verdict.blocked
      ? 'This workspace runs the strict preset, where readiness blocks.'
      : 'Readiness is a signal, not a wall — proceed with `--override "<reason>"` if this is deliberate.',
  );
  return lines.join('\n');
}

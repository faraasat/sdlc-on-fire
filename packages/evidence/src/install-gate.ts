import type { PackageAssessment, PackageVerdict } from '@sdlc-on-fire/core';

/**
 * The package-install approval gate (P2-SEC-01, `.research/14 §what we adopt`).
 *
 * **Any install needs a human by default.** Not "any suspicious install" — any.
 * `.research/14` puts the flat default first for a reason: it stops the naive
 * failure mode (an agent installs a hallucinated package with nobody in the
 * loop) without needing the scoring to be right. The classifier's job is to make
 * that approval *informed*, not to replace it.
 *
 * **`slop` is struck, not surfaced for approval.** A package with a live
 * advisory or a quantified typosquat match should never reach a plan where
 * someone might wave it through at the end of a long day. Refusing it outright
 * is the only treatment that does not depend on the reviewer being alert.
 *
 * **A failed install is a checkpoint, never a retry.** `.research/14 §21` is
 * blunt about why: "try a similarly-named package instead" is *precisely* the
 * auto-recovery that lets a squatted near-miss name through. Install is
 * therefore excluded from auto-fix and from install-failure retry, and this
 * module says so rather than leaving it to a convention nobody enforces.
 */

export type InstallDecision = 'blocked' | 'needs-human' | 'allowed';

export interface InstallGateResult {
  readonly decision: InstallDecision;
  /** Packages that must never be installed, with the finding that struck them. */
  readonly struck: readonly PackageAssessment[];
  /** Packages a human must look at before the install proceeds. */
  readonly review: readonly PackageAssessment[];
  readonly cleared: readonly PackageAssessment[];
  /** What to tell the person reading this, in order of what matters. */
  readonly reasons: readonly string[];
}

export interface InstallGateOptions {
  /**
   * Whether an all-`ok` install still needs a human.
   *
   * Defaults to **true**, matching the flat default. Turning it off is a real
   * decision a workspace can make; it is not the shipped behaviour, because the
   * scoring is not measured on anyone's corpus yet.
   */
  readonly approveEveryInstall?: boolean | undefined;
}

const ORDER: Record<PackageVerdict, number> = { slop: 0, sus: 1, assumed: 2, ok: 3 };

/**
 * Decides whether an install may proceed.
 *
 * Deterministic: assessments in, decision out. No model participates, which is
 * what makes this a gate rather than an opinion.
 */
export function evaluateInstallGate(
  assessments: readonly PackageAssessment[],
  options: InstallGateOptions = {},
): InstallGateResult {
  const sorted = [...assessments].sort(
    (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.name.localeCompare(b.name),
  );

  const struck = sorted.filter((a) => a.verdict === 'slop');
  const review = sorted.filter((a) => a.verdict === 'sus' || a.verdict === 'assumed');
  const cleared = sorted.filter((a) => a.verdict === 'ok');
  const reasons: string[] = [];

  for (const item of struck) {
    reasons.push(`${item.name}: REFUSED — ${item.reasons.join('; ')}`);
  }
  for (const item of review) {
    reasons.push(
      `${item.name}: needs a look — ${
        item.reasons.length === 0 ? 'no signals available' : item.reasons.join('; ')
      }`,
    );
  }

  if (struck.length > 0) {
    reasons.push(
      'Refused rather than offered for approval: a live advisory or a quantified typosquat ' +
        'match is a conclusion, and a package like that must not reach a list somebody ' +
        'might wave through at the end of a long day.',
    );
    return { decision: 'blocked', struck, review, cleared, reasons };
  }

  if (assessments.length === 0) {
    return {
      decision: 'allowed',
      struck,
      review,
      cleared,
      reasons: ['no packages to install'],
    };
  }

  const approveEveryInstall = options.approveEveryInstall !== false;
  if (review.length > 0 || approveEveryInstall) {
    if (review.length === 0) {
      reasons.push(
        'Every package cleared the checks. Approval is still required because the shipped ' +
          'default is that a human sees any install — the scoring is not yet measured on ' +
          'our own corpus, and an unmeasured score is not a reason to skip the human.',
      );
    }
    return { decision: 'needs-human', struck, review, cleared, reasons };
  }

  return {
    decision: 'allowed',
    struck,
    review,
    cleared,
    reasons: ['every package cleared, and this workspace has opted out of blanket approval'],
  };
}

/**
 * Whether a failed install may be retried automatically.
 *
 * Always no, and it is a function rather than a comment so the rule is
 * importable and testable. The auto-recovery that reaches for a
 * similarly-named package is the exact mechanism a squatted near-miss needs.
 */
export function mayAutoRetryInstall(): false {
  return false;
}

export function formatInstallGate(result: InstallGateResult): string {
  const lines = [
    result.decision === 'blocked'
      ? '✗ install BLOCKED'
      : result.decision === 'needs-human'
        ? '⏸ install needs human approval'
        : '✓ install allowed',
  ];
  for (const reason of result.reasons) lines.push(`  ${reason}`);
  if (result.cleared.length > 0) {
    lines.push(`  cleared: ${result.cleared.map((a) => a.name).join(', ')}`);
  }
  return lines.join('\n');
}

import type { InjectionFinding, SecretFinding } from '@sdlc-on-fire/core';

/**
 * The security gate (P2-SEC-02).
 *
 * Turns findings into one decision. Deliberately shaped like the install gate
 * from P2-SEC-01, because a person who has learned to read one of these should
 * not have to learn a second vocabulary to read the other.
 *
 * **A known-format secret blocks; it is not offered for approval.** There is no
 * judgement call to delegate: a string matching `ghp_` followed by 36 base62
 * characters is a GitHub token, and committing it means rotating it. Putting
 * that on an approval list means someone eventually approves it at 6pm on a
 * Friday.
 *
 * **An unverified scan is not a passing scan.** If the scanners could not run,
 * the gate says so and asks, rather than reporting the clean result that an
 * empty findings list would otherwise imply.
 */

export type SecurityDecision = 'blocked' | 'needs-human' | 'clean';

export interface SecurityGateInput {
  readonly secrets: readonly SecretFinding[];
  readonly injections: readonly InjectionFinding[];
  /** Scanners that could not run, and why. Absence of evidence, reported. */
  readonly unverified?: readonly string[] | undefined;
}

export interface SecurityGateResult {
  readonly decision: SecurityDecision;
  readonly blocking: readonly SecretFinding[];
  readonly review: readonly (SecretFinding | InjectionFinding)[];
  readonly unverified: readonly string[];
  readonly reasons: readonly string[];
}

const isSecret = (finding: SecretFinding | InjectionFinding): finding is SecretFinding =>
  'confidence' in finding;

export function evaluateSecurityGate(input: SecurityGateInput): SecurityGateResult {
  const unverified = input.unverified ?? [];

  // A vendor-shaped credential is a conclusion, not a suspicion.
  const blocking = input.secrets.filter((f) => f.confidence === 'known-format');
  const review: (SecretFinding | InjectionFinding)[] = [
    ...input.secrets.filter((f) => f.confidence !== 'known-format'),
    ...input.injections,
  ];

  // Every finding is reported, whatever the decision.
  //
  // An earlier version returned as soon as it had a blocking finding, so a
  // blocked scan printed the secret and silently swallowed the injection
  // findings sitting right next to it. The unit test even asserted the lesser
  // findings "survive onto the result so the fix is one pass" — and they did,
  // on the result object, where nothing printed them. The person at the
  // terminal fixed the secret, re-ran, and only then met the other two.
  // Reporting everything is what makes one pass actually one pass.
  const reasons: string[] = [];
  for (const finding of blocking) {
    reasons.push(`REFUSED — ${finding.rule} at line ${String(finding.line)}: ${finding.preview}`);
  }
  if (blocking.length > 0) {
    reasons.push(
      'A credential in a recognised vendor format is already compromised the moment it is written down here. Rotate it; do not approve past it.',
    );
  }
  for (const finding of review) {
    reasons.push(
      isSecret(finding)
        ? `looks like a secret — ${finding.rule} at line ${String(finding.line)}: ${finding.preview}`
        : `possible injection — ${finding.rule} (${finding.category}) at line ${String(finding.line)}: ${finding.excerpt}`,
    );
  }
  for (const detail of unverified) {
    reasons.push(`not checked — ${detail}`);
  }

  const decision: SecurityDecision =
    blocking.length > 0
      ? 'blocked'
      : review.length > 0 || unverified.length > 0
        ? 'needs-human'
        : 'clean';

  return { decision, blocking, review, unverified, reasons };
}

export function formatSecurityGate(result: SecurityGateResult): string {
  const lines = [
    result.decision === 'blocked'
      ? '✗ security scan BLOCKED'
      : result.decision === 'needs-human'
        ? '⏸ security scan needs a human'
        : '✓ security scan clean',
  ];
  for (const reason of result.reasons) lines.push(`  ${reason}`);
  return lines.join('\n');
}

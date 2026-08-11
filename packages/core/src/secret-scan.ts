/**
 * Secret detection (P2-SEC-02, `.research/14 §(c)`).
 *
 * Two layers, because one is not enough and the research says so plainly.
 *
 * 1. **Known formats.** A GitHub token starts `ghp_`, an AWS key `AKIA`, a
 *    Stripe live key `sk_live_`. These are high-confidence: the shape *is* the
 *    evidence, and a match needs no entropy argument to be worth stopping for.
 * 2. **Entropy.** Everything else — a rotated internal token, a database URL
 *    with a password in it, a format published after this file was written.
 *    Randomness is the only signal left when the shape is unknown.
 *
 * Entropy alone would be unusable: English prose scores around 4.0 bits/char in
 * short spans, and so does base64. The discrimination comes from requiring
 * *both* high entropy and a shape that looks assigned rather than written —
 * length, a mixed alphabet, no spaces. `.research/14` cites the reference
 * numbers: `password123` scores ~2.1, a real key ~4.0.
 *
 * **This is the layer that always runs.** The gitleaks adapter is better at
 * this job and should be preferred where it exists, but a scanner that only
 * works once someone installs a Go binary protects nobody on the day it
 * matters. So this ships in-process, and gitleaks adds to it rather than
 * replacing it.
 */

import {
  EMPTY_ALLOWLIST,
  hasInlineAllow,
  isAllowlistedValue,
  type SecretAllowlist,
} from './secret-allowlist.js';

/** How sure we are, which decides whether a finding blocks or asks. */
export type SecretConfidence = 'known-format' | 'high-entropy';

export interface SecretFinding {
  readonly rule: string;
  readonly confidence: SecretConfidence;
  /** 1-indexed, so it lines up with what an editor shows. */
  readonly line: number;
  /** The match, already masked. The finding must never carry the secret. */
  readonly preview: string;
}

interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Shapes that identify themselves.
 *
 * Deliberately anchored on the vendor prefix rather than on length alone:
 * matching "40 hex characters" would flag every git SHA in every log.
 */
const KNOWN_FORMATS: readonly SecretRule[] = [
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key', pattern: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // A password sitting in a connection string is a secret regardless of shape.
  { id: 'url-credentials', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/gi },
];

/** Assignment shapes — `TOKEN = "..."` — where the right side is the candidate. */
const ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*[:=]\s*["'`]?([A-Za-z0-9+/_=-]{20,})["'`]?/g;

/** Names that mean the value beside them is meant to be secret. */
const SECRET_NAME =
  /(secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|credential|auth)/i;

/** Values that are obviously placeholders, not credentials. */
const PLACEHOLDER =
  /^(?:x{4,}|\*{4,}|\.{3,}|<[^>]+>|\$\{[^}]+\}|your[_-]|example|changeme|placeholder|redacted|dummy|sample|test)/i;

export const ENTROPY_THRESHOLD = 4.0;

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Masks a secret for reporting.
 *
 * A finding that quotes the secret in full copies it into the report, the
 * evidence bundle, the CI log, and the terminal scrollback — which is more
 * copies than it had before anyone noticed. Enough characters survive to
 * recognise which credential it is, and not enough to use it.
 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(value.length - 8, 12))}${value.slice(-4)}`;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content[i] === '\n') line += 1;
  return line;
}

/**
 * Every secret-shaped string in `content`.
 *
 * Reports all findings rather than the first: a commit that leaked one key
 * usually leaked the file it lived in, and stopping at the first turns one
 * fix into a sequence of re-runs.
 *
 * The allowlist is honoured *here*, at the point of detection, rather than by
 * filtering the results afterwards — a masked finding cannot be compared
 * against an allowlist pattern, and unmasking one to check would put the
 * credential back into a variable for the sake of deciding it was never a
 * credential.
 */
export function scanForSecrets(
  content: string,
  allowlist: SecretAllowlist = EMPTY_ALLOWLIST,
): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const claimed: { start: number; end: number }[] = [];
  const lines = content.split('\n');
  // A marker exempts the line it sits on. Line-level rather than file-level so
  // annotating one fixture does not blind the scanner to the rest of the file.
  const allowedLine = (line: number): boolean => hasInlineAllow(lines[line - 1] ?? '');

  for (const rule of KNOWN_FORMATS) {
    for (const match of content.matchAll(rule.pattern)) {
      const index = match.index;
      claimed.push({ start: index, end: index + match[0].length });
      const line = lineOf(content, index);
      if (allowedLine(line) || isAllowlistedValue(allowlist, match[0], lines[line - 1] ?? ''))
        continue;
      findings.push({
        rule: rule.id,
        confidence: 'known-format',
        line,
        preview: maskSecret(match[0]),
      });
    }
  }

  for (const match of content.matchAll(ASSIGNMENT)) {
    const [, name, value] = match;
    if (name === undefined || value === undefined) continue;

    const index = match.index + match[0].indexOf(value);
    // A known-format rule already reported this span; two findings for one
    // string reads as two leaked credentials.
    if (claimed.some((span) => index >= span.start && index < span.end)) continue;
    if (PLACEHOLDER.test(value)) continue;

    const named = SECRET_NAME.test(name);
    const entropy = shannonEntropy(value);
    // A secret-ish *name* lowers the bar but never removes it — `API_KEY = ""`
    // in a template is the single most common line in every example config
    // ever written, and flagging it trains people to ignore this scanner.
    if (entropy < (named ? 3.5 : ENTROPY_THRESHOLD)) continue;

    const line = lineOf(content, index);
    if (allowedLine(line) || isAllowlistedValue(allowlist, value, lines[line - 1] ?? '')) continue;

    findings.push({
      rule: named ? `secret-assignment:${name}` : 'high-entropy-string',
      confidence: 'high-entropy',
      line,
      preview: maskSecret(value),
    });
  }

  return findings.sort((a, b) => a.line - b.line);
}

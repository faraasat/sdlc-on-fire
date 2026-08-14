import { describe, expect, it } from 'vitest';
import {
  checkTestEnvironment,
  evaluateHarnessRun,
  formatHarnessRun,
  scanArtifact,
  TEST_CREDENTIAL_MARKER,
  type TestCredential,
  type TestEnvironmentPolicy,
  type TestTarget,
} from './test-environment.js';

/**
 * P2-QA-06 — what stops this being pointed at production.
 *
 * ADR-0052 permits an agent to authenticate and run real flows, then says the
 * test-vs-real distinction "must be enforced by the environment setup, not by
 * the agent's judgment". These cases are that enforcement: every one of them is
 * a way a run against production looks exactly like a run against staging until
 * the data changes.
 */

const policy = (overrides: Partial<TestEnvironmentPolicy> = {}): TestEnvironmentPolicy => ({
  allowedHosts: ['staging.example.test', 'localhost'],
  runId: 'run-42',
  allowFormFill: false,
  ...overrides,
});

const target = (overrides: Partial<TestTarget> = {}): TestTarget => ({
  url: 'https://staging.example.test/app',
  tenantId: 'tenant-run-42',
  teardown: 'DELETE /tenants/tenant-run-42',
  ...overrides,
});

const credential = (overrides: Partial<TestCredential> = {}): TestCredential => ({
  id: 'e2e-token',
  value: `${TEST_CREDENTIAL_MARKER}-abc123`,
  strategy: 'token-injection',
  ...overrides,
});

const rules = (verdict: { findings: readonly { rule: string }[] }): string[] =>
  verdict.findings.map((finding) => finding.rule);

describe('checkTestEnvironment', () => {
  it('passes a properly declared disposable target', () => {
    expect(checkTestEnvironment(target(), [credential()], policy()).ok).toBe(true);
  });

  it('refuses a host that is merely not on the allowlist', () => {
    // Allowlist, not denylist. A denylist of production-looking hostnames
    // passes everything nobody thought of, and that is the one that gets typed.
    const verdict = checkTestEnvironment(
      target({ url: 'https://app.example.com/' }),
      [credential()],
      policy(),
    );
    expect(verdict.ok).toBe(false);
    expect(rules(verdict)).toContain('host-allowlist');
  });

  it('refuses a host that looks like staging but is not declared', () => {
    // The point of the allowlist stated as a case: `staging-2` reads as safe to
    // a person and is not on the list, so it is refused. A pattern match on
    // "staging" would have let it through.
    const verdict = checkTestEnvironment(
      target({ url: 'https://staging-2.example.test/' }),
      [credential()],
      policy(),
    );
    expect(rules(verdict)).toContain('host-allowlist');
  });

  it('refuses a target that is not a URL rather than treating it as unknown', () => {
    // And says *that* is the problem. Falling through to the allowlist branch
    // produces "null is not in the allowlist", which sends the reader to edit
    // the allowlist over a malformed URL.
    const verdict = checkTestEnvironment(
      target({ url: 'staging.example.test' }),
      [credential()],
      policy(),
    );
    expect(rules(verdict)).toContain('host-allowlist');
    expect(verdict.findings[0]?.message).toContain('is not a URL');
  });

  it('refuses a tenant not scoped to this run', () => {
    // A shared tenant cannot be torn down without taking someone else's data.
    const verdict = checkTestEnvironment(
      target({ tenantId: 'tenant-shared' }),
      [credential()],
      policy(),
    );
    expect(rules(verdict)).toContain('ephemeral-tenant');
  });

  it('refuses a run with no teardown declared', () => {
    const verdict = checkTestEnvironment(target({ teardown: undefined }), [credential()], policy());
    expect(rules(verdict)).toContain('teardown-declared');
  });

  it('refuses a teardown that is only whitespace', () => {
    expect(
      rules(checkTestEnvironment(target({ teardown: '   ' }), [credential()], policy())),
    ).toContain('teardown-declared');
  });

  it('refuses a credential with no marker in its own value', () => {
    // The marker travels with the string; a config flag saying `testOnly: true`
    // does not survive the value being copied somewhere else.
    const verdict = checkTestEnvironment(target(), [credential({ value: 'hunter2' })], policy());
    expect(rules(verdict)).toContain('test-only-credentials');
  });

  it('refuses a run with no credentials at all', () => {
    // An E2E run with no auth is not the flow under test — and it passes every
    // other check, which is what makes it worth naming.
    expect(rules(checkTestEnvironment(target(), [], policy()))).toContain('test-only-credentials');
  });

  it('refuses form-fill unless the project opted into it', () => {
    const verdict = checkTestEnvironment(
      target(),
      [credential({ strategy: 'form-fill' })],
      policy(),
    );
    expect(rules(verdict)).toContain('form-fill-opt-in');
  });

  it('allows form-fill once the project has', () => {
    const verdict = checkTestEnvironment(
      target(),
      [credential({ strategy: 'form-fill' })],
      policy({ allowFormFill: true }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('reports every reason, not the first', () => {
    // The refusals here are a checklist someone has to work through. Stopping
    // at the first turns one config pass into four.
    const verdict = checkTestEnvironment(
      target({ url: 'https://prod.example.com/', tenantId: 'shared', teardown: undefined }),
      [credential({ value: 'real' })],
      policy(),
    );
    expect(new Set(rules(verdict)).size).toBe(4);
  });
});

describe('scanArtifact', () => {
  it('refuses to persist an artifact carrying a real-looking secret', () => {
    // Scanned before writing, never redacted after: an exact-match redaction
    // breaks the moment the value is re-encoded, and still looks like it worked.
    const scan = scanArtifact({
      path: 'trace.log',
      content: 'POST /login\nAKIAIOSFODNN7EXAMPLE\n',
    });
    expect(scan.persistable).toBe(false);
    expect(scan.findings.length).toBeGreaterThan(0);
  });

  it('persists an artifact whose only secret is a marked test credential', () => {
    // Refusing this would make the evidence pipeline unusable for exactly the
    // runs it exists for — the disposable token is the thing under test.
    const scan = scanArtifact({
      path: 'trace.log',
      content: `Authorization: Bearer ${TEST_CREDENTIAL_MARKER}-AKIAIOSFODNN7EXAMPLE\n`,
    });
    expect(scan.persistable).toBe(true);
  });

  it('still refuses when a real secret sits on a different line from a test one', () => {
    // Line-scoped, so marking one line never blinds the scanner to the rest.
    const scan = scanArtifact({
      path: 'trace.log',
      content: `token=${TEST_CREDENTIAL_MARKER}-x\nAKIAIOSFODNN7EXAMPLE\n`,
    });
    expect(scan.persistable).toBe(false);
  });

  it('reads CRLF artifacts, which is what a Windows run produces', () => {
    const scan = scanArtifact({
      path: 'trace.log',
      content: `a\r\ntoken=${TEST_CREDENTIAL_MARKER}-AKIAIOSFODNN7EXAMPLE\r\n`,
    });
    expect(scan.persistable).toBe(true);
  });
});

describe('evaluateHarnessRun', () => {
  const clean = {
    runId: 'run-42',
    target: target(),
    environment: checkTestEnvironment(target(), [credential()], policy()),
    artifacts: [{ path: 'trace.log', findings: [], persistable: true }],
    toreDown: true,
  };

  it('passes a clean run', () => {
    expect(evaluateHarnessRun(clean).ok).toBe(true);
  });

  it('fails a run whose teardown did not happen', () => {
    // Observed, not inferred from the absence of errors. A run reporting success
    // while leaving a live tenant has reported the wrong thing.
    const run = evaluateHarnessRun({ ...clean, toreDown: false });
    expect(run.ok).toBe(false);
    expect(formatHarnessRun(run)).toContain('the tenant is still live');
  });

  it('fails a run with an unpersistable artifact', () => {
    const run = evaluateHarnessRun({
      ...clean,
      artifacts: [
        { path: 'trace.log', findings: ['aws-access-key at line 2'], persistable: false },
      ],
    });
    expect(run.ok).toBe(false);
  });

  it('fails a run whose environment was refused, whatever else happened', () => {
    const run = evaluateHarnessRun({
      ...clean,
      environment: checkTestEnvironment(
        target({ url: 'https://prod.example.com/' }),
        [credential()],
        policy(),
      ),
    });
    expect(run.ok).toBe(false);
  });
});

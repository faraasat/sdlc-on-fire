import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkTestEnvironment,
  evaluateHarnessRun,
  isSecretPath,
  relativePosix,
  resolveWorkspaceLayout,
  scanArtifact,
  type ArtifactScan,
  type HarnessRun,
  type TestCredential,
  type TestEnvironmentPolicy,
  type TestTarget,
} from '@sdlc-on-fire/core';

/**
 * `sdlc e2e` — the disposable-credential harness's reachable surface
 * (P2-QA-06, ADR-0052).
 *
 * `check` answers the only question that matters before a run starts: may this
 * point where it is pointing, with what it is holding. `seal` answers the one
 * after it finishes: may these captured artifacts be persisted.
 *
 * The config lives in the workspace and the **secrets do not**. That split is
 * the load-bearing part: `e2e.json` declares hosts, tenant and teardown and is
 * committed; credential *values* are read from the environment, and the file
 * names the variables rather than holding them. A config format that could
 * hold a credential is a config format that eventually does, and it is the
 * file people paste into an issue when asking why their run failed.
 */

export const E2E_CONFIG = 'e2e.json';

interface StoredConfig {
  readonly allowedHosts?: readonly string[];
  readonly allowFormFill?: boolean;
  readonly url?: string;
  readonly tenantId?: string;
  readonly teardown?: string;
  /**
   * Credentials by environment-variable name, never by value.
   *
   * `{ "e2e-token": { "env": "E2E_TOKEN", "strategy": "token-injection" } }`.
   */
  readonly credentials?: Readonly<
    Record<string, { env: string; strategy: 'token-injection' | 'form-fill' }>
  >;
}

export interface E2eCheckResult {
  readonly config: string;
  readonly target: TestTarget;
  readonly policy: TestEnvironmentPolicy;
  /** Which declared credentials were actually present in the environment. */
  readonly resolved: readonly string[];
  readonly missing: readonly string[];
  readonly verdict: ReturnType<typeof checkTestEnvironment>;
  readonly ok: boolean;
}

async function readConfig(root: string): Promise<StoredConfig> {
  const layout = resolveWorkspaceLayout(root);
  const full = path.join(layout.root, E2E_CONFIG);
  const raw = await fs.readFile(full, 'utf8').catch(() => null);
  if (raw === null) throw new Error(`no ${E2E_CONFIG} at the workspace root`);
  return JSON.parse(raw) as StoredConfig;
}

/**
 * Checks a run before it starts.
 *
 * `runId` is required and is not defaulted to something derived. A default
 * would make the run-scoped-tenant rule satisfiable by accident, and that rule
 * is the one keeping teardown from deleting somebody else's data.
 */
export async function checkE2e(
  root: string,
  runId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<E2eCheckResult> {
  const config = await readConfig(root);

  const resolved: string[] = [];
  const missing: string[] = [];
  const credentials: TestCredential[] = [];

  for (const [id, declared] of Object.entries(config.credentials ?? {})) {
    const value = env[declared.env];
    if (value === undefined || value === '') {
      missing.push(`${id} (${declared.env})`);
      continue;
    }
    resolved.push(`${id} (${declared.env})`);
    credentials.push({ id, value, strategy: declared.strategy });
  }

  const target: TestTarget = {
    url: config.url ?? '',
    tenantId: config.tenantId ?? '',
    ...(config.teardown === undefined ? {} : { teardown: config.teardown }),
  };
  const policy: TestEnvironmentPolicy = {
    allowedHosts: config.allowedHosts ?? [],
    runId,
    allowFormFill: config.allowFormFill === true,
  };

  const verdict = checkTestEnvironment(target, credentials, policy);
  return {
    config: E2E_CONFIG,
    target,
    policy,
    resolved,
    missing,
    verdict,
    // A declared credential that is not in the environment fails the check even
    // though `checkTestEnvironment` never saw it: a run that quietly proceeds
    // with three of four credentials is a run whose auth path changed.
    ok: verdict.ok && missing.length === 0,
  };
}

export interface E2eSealResult {
  readonly runId: string;
  readonly scans: readonly ArtifactScan[];
  readonly run: HarnessRun;
}

/**
 * Scans captured artifacts before any of them are persisted.
 *
 * Everything under the directory, not a declared list. The artifacts that leak
 * are the ones nobody remembered to declare — a Playwright trace dropped
 * alongside the screenshots, a browser console log written by a plugin — and a
 * scanner that only reads what it was told about never sees them.
 */
export async function sealE2eEvidence(
  root: string,
  runId: string,
  directory: string,
  toreDown: boolean,
): Promise<E2eSealResult> {
  const layout = resolveWorkspaceLayout(root);
  const dir = path.join(layout.root, directory);
  const scans: ArtifactScan[] = [];

  const walk = async (current: string, relative: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), next);
        continue;
      }
      // A path the denylist already refuses is not opened to check what is in
      // it — reading `.env` to decide whether it holds secrets puts the secrets
      // in this process, which is the thing the denylist prevents.
      if (isSecretPath(next).denied) {
        scans.push({
          path: next,
          findings: ['a credential path — not read, and never persisted'],
          persistable: false,
        });
        continue;
      }
      const content = await fs.readFile(path.join(current, entry.name), 'utf8').catch(() => null);
      if (content === null) continue;
      scans.push(scanArtifact({ path: next, content }));
    }
  };

  await walk(dir, '');

  const config: StoredConfig = await readConfig(root).catch(() => ({}));
  const target: TestTarget = {
    url: config.url ?? '',
    tenantId: config.tenantId ?? '',
    ...(config.teardown === undefined ? {} : { teardown: config.teardown }),
  };

  return {
    runId,
    scans,
    run: evaluateHarnessRun({
      runId,
      target,
      // The environment was checked before the run; sealing judges the output.
      environment: { ok: true, findings: [] },
      artifacts: scans,
      toreDown,
    }),
  };
}

export function formatE2eCheck(result: E2eCheckResult): string {
  const lines = [
    `${result.target.url || '(no url)'} · tenant ${result.target.tenantId || '(none)'} · run ${result.policy.runId}`,
  ];

  for (const id of result.resolved) lines.push(`  ✓ ${id} present`);
  for (const id of result.missing) lines.push(`  ✗ ${id} not in the environment`);
  for (const finding of result.verdict.findings) {
    lines.push(`  ✗ ${finding.rule}: ${finding.message}`);
  }

  lines.push(
    '',
    result.ok
      ? 'Target is declared disposable and every credential is marked test-only. Run may proceed.'
      : 'Refused. The test-vs-real distinction is enforced here rather than left to judgement (ADR-0052).',
  );
  return lines.join('\n');
}

export function formatE2eSeal(result: E2eSealResult, root: string): string {
  const lines = [`${String(result.scans.length)} artifact(s) scanned`];

  for (const scan of result.scans.filter((entry) => !entry.persistable)) {
    lines.push(`  ✗ ${scan.path}: ${scan.findings.join(', ')}`);
  }
  if (!result.run.toreDown) lines.push('  ✗ teardown did not run — the tenant is still live');

  lines.push(
    '',
    result.run.ok
      ? `All artifacts clean; safe to persist under ${relativePosix(root, root)}.`
      : 'Refused. Artifacts are scanned before they are written, not redacted after — an',
  );
  if (!result.run.ok) {
    lines.push('exact-match redaction breaks the moment a value is re-encoded, and still looks');
    lines.push('like it worked.');
  }
  return lines.join('\n');
}

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_CREDENTIAL_MARKER } from '@sdlc-on-fire/core';
import { checkE2e, E2E_CONFIG, sealE2eEvidence } from './e2e.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `sdlc e2e` against a real workspace (P2-QA-06).
 *
 * The unit tests establish that the rules refuse. These establish that the
 * *commands* refuse — and cover the two things only a filesystem can show: that
 * credential values never come from the config file, and that sealing reads
 * every artifact in the tree rather than a declared list.
 */

const dirs: string[] = [];

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-e2e-h-'));
  dirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return root;
}

const config = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    allowedHosts: ['staging.example.test'],
    url: 'https://staging.example.test/app',
    tenantId: 'tenant-run-42',
    teardown: 'DELETE /tenants/tenant-run-42',
    credentials: { 'e2e-token': { env: 'E2E_TOKEN', strategy: 'token-injection' } },
    ...overrides,
  });

const marked = `${TEST_CREDENTIAL_MARKER}-abc123`;

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('checkE2e', () => {
  it('passes a declared disposable target with a marked credential in the environment', async () => {
    const root = await workspace({ [E2E_CONFIG]: config() });
    const result = await checkE2e(root, 'run-42', { E2E_TOKEN: marked });
    expect(result.ok).toBe(true);
    expect(result.resolved).toEqual(['e2e-token (E2E_TOKEN)']);
  });

  it('fails when a declared credential is missing from the environment', async () => {
    // It would otherwise pass every rule that ran, because the rule engine never
    // saw the credential at all — a run proceeding with three of four
    // credentials is a run whose auth path silently changed.
    const root = await workspace({ [E2E_CONFIG]: config() });
    const result = await checkE2e(root, 'run-42', {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['e2e-token (E2E_TOKEN)']);
  });

  it('fails on one missing credential even when the others are fine', async () => {
    // The case the previous test cannot make: with *every* credential missing,
    // the rule engine refuses anyway for "no credentials declared". Here the
    // rules all pass and only the missing one is wrong — which is exactly the
    // run that would otherwise proceed with a quietly different auth path.
    const root = await workspace({
      [E2E_CONFIG]: config({
        credentials: {
          'e2e-token': { env: 'E2E_TOKEN', strategy: 'token-injection' },
          'admin-token': { env: 'E2E_ADMIN_TOKEN', strategy: 'token-injection' },
        },
      }),
    });

    const result = await checkE2e(root, 'run-42', { E2E_TOKEN: marked });
    expect(result.verdict.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['admin-token (E2E_ADMIN_TOKEN)']);
  });

  it('reads credential values from the environment, never from the config', async () => {
    // The load-bearing split. A config format that *can* hold a credential is
    // one that eventually does, and it is the file people paste into an issue
    // when asking why their run failed.
    const root = await workspace({
      [E2E_CONFIG]: config({
        credentials: {
          'e2e-token': { env: 'E2E_TOKEN', strategy: 'token-injection', value: marked },
        },
      }),
    });
    const result = await checkE2e(root, 'run-42', {});
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  it('refuses a run id that does not match the tenant', async () => {
    const root = await workspace({ [E2E_CONFIG]: config() });
    const result = await checkE2e(root, 'run-99', { E2E_TOKEN: marked });
    expect(result.verdict.findings.map((f) => f.rule)).toContain('ephemeral-tenant');
  });

  it('refuses an unmarked credential even on an allowed host', async () => {
    const root = await workspace({ [E2E_CONFIG]: config() });
    const result = await checkE2e(root, 'run-42', { E2E_TOKEN: 'hunter2' });
    expect(result.ok).toBe(false);
  });

  it('says the config is missing rather than defaulting to permissive', async () => {
    const root = await workspace();
    await expect(checkE2e(root, 'run-42', {})).rejects.toThrow(/no e2e\.json/);
  });
});

describe('sealE2eEvidence', () => {
  it('scans every artifact in the tree, not a declared list', async () => {
    // The artifacts that leak are the ones nobody remembered to declare — a
    // trace dropped beside the screenshots, a console log written by a plugin.
    const root = await workspace({
      [E2E_CONFIG]: config(),
      'artifacts/trace.log': 'ok\n',
      'artifacts/nested/deep/console.log': 'AKIAIOSFODNN7EXAMPLE\n',
    });

    const result = await sealE2eEvidence(root, 'run-42', 'artifacts', true);
    expect(result.scans).toHaveLength(2);
    expect(result.run.ok).toBe(false);
  });

  it('persists an artifact whose only secret is a marked test credential', async () => {
    const root = await workspace({
      [E2E_CONFIG]: config(),
      'artifacts/auth.log': `Bearer ${TEST_CREDENTIAL_MARKER}-AKIAIOSFODNN7EXAMPLE\n`,
    });

    const result = await sealE2eEvidence(root, 'run-42', 'artifacts', true);
    expect(result.run.ok).toBe(true);
  });

  it('refuses a credential path without opening it', async () => {
    // Reading `.env` to decide whether it holds secrets puts the secrets into
    // this process, which is the thing the denylist exists to prevent.
    const root = await workspace({
      [E2E_CONFIG]: config(),
      'artifacts/.env': 'SECRET=whatever\n',
    });

    const result = await sealE2eEvidence(root, 'run-42', 'artifacts', true);
    expect(result.run.ok).toBe(false);
    expect(result.scans[0]?.findings.join(' ')).toContain('not read');
  });

  it('fails a run whose teardown did not happen, however clean the artifacts', async () => {
    const root = await workspace({ [E2E_CONFIG]: config(), 'artifacts/trace.log': 'ok\n' });
    const result = await sealE2eEvidence(root, 'run-42', 'artifacts', false);
    expect(result.run.ok).toBe(false);
  });

  it('passes a clean run that tore its tenant down', async () => {
    const root = await workspace({ [E2E_CONFIG]: config(), 'artifacts/trace.log': 'ok\n' });
    expect((await sealE2eEvidence(root, 'run-42', 'artifacts', true)).run.ok).toBe(true);
  });
});

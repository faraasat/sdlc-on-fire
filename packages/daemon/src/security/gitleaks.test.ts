import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGitleaks, type CommandRunner } from './gitleaks.js';

/**
 * P2-SEC-02 — the gitleaks adapter.
 *
 * Same discipline as the OSV adapter, for the same reason: P2-SEC-01 shipped a
 * lookup whose request was malformed, and because the failure path was
 * fail-closed, nothing looked wrong. An empty findings array from a scanner
 * that never ran is indistinguishable from a clean scan unless the adapter is
 * built to distinguish them. So `status` is not decoration — it is the field
 * that keeps "gitleaks is not installed" from being read as "no secrets".
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitleaks-'));
  dirs.push(root);
  return root;
}

/** Writes the report gitleaks would have written, then behaves as gitleaks does. */
const runnerWriting = (entries: unknown[], exitCode?: number): CommandRunner => {
  return async (_file, args) => {
    const reportPath = args[args.indexOf('--report-path') + 1];
    await fs.writeFile(reportPath!, JSON.stringify(entries), 'utf8');
    if (exitCode !== undefined) {
      throw Object.assign(new Error('gitleaks found leaks'), { code: exitCode });
    }
    return { stdout: '', stderr: '' };
  };
};

describe('runGitleaks', () => {
  it('reports not-installed rather than clean when the binary is missing', async () => {
    const result = await runGitleaks(await workspace(), {
      runner: () => Promise.reject(Object.assign(new Error('spawn gitleaks'), { code: 'ENOENT' })),
    });

    // The load-bearing assertion of this file. `findings: []` is true and
    // useless on its own; `status` is what stops it becoming "no secrets found".
    expect(result.status).toBe('not-installed');
    expect(result.findings).toEqual([]);
    expect(result.detail).toContain('not on PATH');
  });

  it('treats exit code 1 as a successful scan that found something', async () => {
    // gitleaks exits 1 when it finds leaks, which execFile throws on. Reading
    // that as a failure would report every genuine detection as a broken
    // scanner — and a broken scanner is something people stop looking at.
    const result = await runGitleaks(await workspace(), {
      runner: runnerWriting(
        [{ RuleID: 'aws-access-token', StartLine: 12, Secret: 'AKIAIOSFODNN7EXAMPLE' }],
        1,
      ),
    });

    expect(result.status).toBe('ran');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe('gitleaks:aws-access-token');
    expect(result.findings[0]?.line).toBe(12);
  });

  it('masks the secret out of the report', async () => {
    // gitleaks' JSON report carries the raw credential. It must not leave here.
    const result = await runGitleaks(await workspace(), {
      runner: runnerWriting([{ RuleID: 'x', StartLine: 1, Secret: 'AKIAIOSFODNN7EXAMPLE' }], 1),
    });
    expect(result.findings[0]?.preview).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(result.findings[0]?.preview).toContain('*');
  });

  it('reports a clean scan as clean', async () => {
    const result = await runGitleaks(await workspace(), { runner: runnerWriting([]) });
    expect(result.status).toBe('ran');
    expect(result.findings).toEqual([]);
    expect(result.detail).toBeUndefined();
  });

  it('reports failed — not clean — on an unexpected exit code', async () => {
    const result = await runGitleaks(await workspace(), {
      runner: () => Promise.reject(Object.assign(new Error('boom'), { code: 2 })),
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('2');
  });

  it('reports failed when the scanner claims success but writes no report', async () => {
    // "It ran and found nothing" and "it produced nothing" are different
    // claims, and only one of them is evidence.
    const result = await runGitleaks(await workspace(), {
      runner: () => Promise.resolve({ stdout: '', stderr: '' }),
    });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('no report');
  });

  it('reports failed on an unparseable report', async () => {
    const result = await runGitleaks(await workspace(), {
      runner: async (_file, args) => {
        const reportPath = args[args.indexOf('--report-path') + 1];
        await fs.writeFile(reportPath!, 'not json at all', 'utf8');
        return { stdout: '', stderr: '' };
      },
    });
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([]);
  });

  it('scans the working tree, not just committed history', async () => {
    let seen: readonly string[] = [];
    await runGitleaks(await workspace(), {
      runner: async (_file, args) => {
        seen = args;
        const reportPath = args[args.indexOf('--report-path') + 1];
        await fs.writeFile(reportPath!, '[]', 'utf8');
        return { stdout: '', stderr: '' };
      },
    });
    // `--no-git` is what catches a secret that is written but not yet
    // committed — the moment when fixing it is still cheap.
    expect(seen).toContain('--no-git');
    expect(seen).toContain('detect');
  });
});

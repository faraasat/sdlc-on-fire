import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { SecretFinding } from '@sdlc-on-fire/core';
import { maskSecret } from '@sdlc-on-fire/core';

/**
 * The gitleaks adapter (P2-SEC-02, `.research/14 §(c)`, ADR-0045).
 *
 * gitleaks is the reference secret scanner: per-format regexes tuned to real
 * vendor token shapes, entropy scoring, and `.gitleaks.toml` for org-specific
 * rules. ADR-0045 says prefer the dependency's official CLI, and this does —
 * it shells out to the real binary rather than reimplementing its rule pack.
 *
 * **When gitleaks is absent, this reports absent — never clean.** That
 * distinction is the whole reason this file has a status field. P2-SEC-01
 * shipped an advisory adapter whose request was malformed: every call failed,
 * every verdict came back "nothing known", and because the design was
 * fail-closed nothing *looked* wrong for an entire build. A scanner that
 * returns an empty findings array when it never ran is the same bug wearing
 * different clothes, and an empty array is exactly what "no secrets found"
 * looks like.
 *
 * So the in-process scanner in `@sdlc-on-fire/core` is the layer that always
 * runs, and this one adds to it. `scanSecrets` composes both, and reports which
 * of them actually executed.
 */

const run = promisify(execFile);

export type GitleaksStatus = 'ran' | 'not-installed' | 'failed';

export interface GitleaksResult {
  readonly status: GitleaksStatus;
  readonly findings: readonly SecretFinding[];
  /** Present when `status` is not `ran`. Names the cause, so it can be fixed. */
  readonly detail?: string | undefined;
}

/** Injected in tests, so "gitleaks is missing" is a state rather than a mock. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

interface GitleaksReportEntry {
  RuleID?: string;
  Description?: string;
  StartLine?: number;
  Secret?: string;
  Match?: string;
}

export interface GitleaksOptions {
  readonly runner?: CommandRunner | undefined;
  readonly timeoutMs?: number | undefined;
}

const defaultRunner: CommandRunner = (file, args) =>
  run(file, [...args], { maxBuffer: 32 * 1024 * 1024 });

/**
 * Runs `gitleaks detect` over a directory.
 *
 * `--no-git` because the interesting content is the working tree at the moment
 * the gate runs — including files staged but not committed, which is precisely
 * when catching a secret is still cheap.
 *
 * gitleaks exits 1 when it finds leaks, which `execFile` surfaces as a thrown
 * error. That is a successful scan with findings, not a failure, and confusing
 * the two would report every genuine detection as "the scanner broke".
 */
export async function runGitleaks(
  target: string,
  options: GitleaksOptions = {},
): Promise<GitleaksResult> {
  const runner = options.runner ?? defaultRunner;
  const report = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'gitleaks-')), 'report.json');

  try {
    await runner('gitleaks', [
      'detect',
      '--source',
      target,
      '--no-git',
      '--report-format',
      'json',
      '--report-path',
      report,
      '--exit-code',
      '1',
    ]);
  } catch (error) {
    // `execFile` reports a missing binary as `code: 'ENOENT'` and a non-zero
    // exit as `code: <number>`, in the same field.
    const failure = error as { code?: number | string | undefined };
    if (failure.code === 'ENOENT') {
      return {
        status: 'not-installed',
        findings: [],
        detail: 'gitleaks is not on PATH — the built-in scanner ran alone',
      };
    }
    // Exit 1 is "leaks found". Anything else is a real failure.
    if (failure.code !== 1) {
      return {
        status: 'failed',
        findings: [],
        detail: `gitleaks exited with ${String(failure.code)}`,
      };
    }
  }

  const raw = await fs.readFile(report, 'utf8').catch(() => null);
  if (raw === null) {
    // The scanner claimed to run but left nothing behind. Reporting zero
    // findings here would be inventing a result.
    return { status: 'failed', findings: [], detail: 'gitleaks wrote no report' };
  }

  let entries: GitleaksReportEntry[];
  try {
    entries = (JSON.parse(raw) as GitleaksReportEntry[] | null) ?? [];
  } catch {
    return { status: 'failed', findings: [], detail: 'gitleaks report was not valid JSON' };
  }

  return {
    status: 'ran',
    findings: entries.map((entry) => ({
      rule: `gitleaks:${entry.RuleID ?? 'unknown'}`,
      confidence: 'known-format' as const,
      line: entry.StartLine ?? 0,
      // The report carries the raw secret. It does not leave this function.
      preview: maskSecret(entry.Secret ?? entry.Match ?? ''),
    })),
  };
}

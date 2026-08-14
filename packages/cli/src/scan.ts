import fs from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_ALLOWLIST,
  isAllowlistedPath,
  joinPosix,
  isSecretPath,
  parseSecretAllowlist,
  scanForInjection,
  scanForSecrets,
  type InjectionFinding,
  type SecretAllowlist,
  type SecretFinding,
} from '@sdlc-on-fire/core';
import {
  evaluateSecurityGate,
  formatSecurityGate,
  type SecurityGateResult,
} from '@sdlc-on-fire/evidence';
import { runGitleaks, type GitleaksOptions } from '@sdlc-on-fire/daemon';

/**
 * `sdlc scan` (P2-SEC-02).
 *
 * The reachable surface for the security layer. P2-SEC-01's walkthrough
 * established the rule this follows: a check nobody can run is not a check.
 */

/** Directories never worth scanning — vendored code is not this repo's secret. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.pnpm-store',
]);

/**
 * Generated files whose high-entropy content is not a secret.
 *
 * A lockfile is the worst case: `pnpm-lock.yaml` alone produced 540 findings
 * on this repo, one per integrity digest. Those digests are published, are
 * meant to be published, and are the entire point of the file — and 540 of
 * anything buries the handful of findings that matter. Skipping generated
 * files is not a weakening of the scan; the credentials worth catching are in
 * files a person wrote.
 */
const GENERATED = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Gemfile.lock',
  '.pnp.cjs',
]);

/** Extensions whose contents are bytes, not text. */
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.mp4',
  '.wasm',
  '.onnx',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ScanResult {
  readonly root: string;
  readonly filesScanned: number;
  readonly skippedSecretPaths: readonly string[];
  /** Files exempted by `.gitleaks.toml`. Reported, so an exemption is visible. */
  readonly allowlistedPaths: readonly string[];
  readonly gitleaks: string;
  readonly gate: SecurityGateResult;
}

/**
 * Reads the repo's `.gitleaks.toml`, if it has one.
 *
 * The same file gitleaks itself reads (added by P0-META-04). One config, so
 * the two scanning layers cannot disagree about what counts as an example.
 */
async function loadAllowlist(root: string): Promise<SecretAllowlist> {
  const raw = await fs.readFile(path.join(root, '.gitleaks.toml'), 'utf8').catch(() => null);
  return raw === null ? EMPTY_ALLOWLIST : parseSecretAllowlist(raw);
}

async function* walk(root: string, relative = ''): AsyncGenerator<string> {
  const entries = await fs
    .readdir(path.join(root, relative), { withFileTypes: true })
    .catch(() => []);

  for (const entry of entries) {
    // `joinPosix`, not `path.join`: this value is matched against the globs in
    // `.gitleaks.toml` and printed into every finding. Built with `path.join`
    // it read `src\config.ts` on Windows, where no allowlist entry anyone wrote
    // matches it — an exemption silently stopped applying, and each finding
    // named a path that could not be pasted back into the config.
    const next = joinPosix(relative, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(root, next);
    } else if (entry.isFile()) {
      yield next;
    }
  }
}

export interface ScanOptions {
  /** Injected so the gitleaks-missing path is a real state in tests. */
  readonly gitleaks?: GitleaksOptions | undefined;
  readonly skipGitleaks?: boolean | undefined;
}

export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const secrets: SecretFinding[] = [];
  const injections: InjectionFinding[] = [];
  const skippedSecretPaths: string[] = [];
  const allowlistedPaths: string[] = [];
  const allowlist = await loadAllowlist(root);
  let filesScanned = 0;

  for await (const relative of walk(root)) {
    // A denylisted path is not read at all. Opening `.env` to check whether it
    // contains secrets pulls the secrets into this process, which is the thing
    // the denylist exists to prevent — and the finding would report the file
    // we already knew about.
    if (isSecretPath(relative).denied) {
      skippedSecretPaths.push(relative);
      continue;
    }
    if (GENERATED.has(path.basename(relative))) continue;
    if (isAllowlistedPath(allowlist, relative)) {
      allowlistedPaths.push(relative);
      continue;
    }
    if (BINARY.has(path.extname(relative).toLowerCase())) continue;

    const full = path.join(root, relative);
    const stat = await fs.stat(full).catch(() => null);
    if (stat === null || stat.size > MAX_FILE_BYTES) continue;

    const content = await fs.readFile(full, 'utf8').catch(() => null);
    if (content === null) continue;
    filesScanned += 1;

    for (const finding of scanForSecrets(content, allowlist)) {
      secrets.push({ ...finding, rule: `${relative}:${finding.rule}` });
    }
    for (const finding of scanForInjection(content).findings) {
      injections.push({ ...finding, rule: `${relative}:${finding.rule}` });
    }
  }

  const unverified: string[] = [];
  let gitleaksStatus = 'skipped';
  if (options.skipGitleaks !== true) {
    const result = await runGitleaks(root, options.gitleaks ?? {});
    gitleaksStatus = result.status;
    secrets.push(...result.findings);
    // "gitleaks did not run" is reported as an unchecked layer rather than
    // folded into a clean result. An empty findings array from a scanner that
    // never started looks exactly like a passing scan.
    if (result.status !== 'ran') {
      unverified.push(result.detail ?? `gitleaks ${result.status}`);
    }
  }

  return {
    root,
    filesScanned,
    skippedSecretPaths,
    allowlistedPaths,
    gitleaks: gitleaksStatus,
    gate: evaluateSecurityGate({ secrets, injections, unverified }),
  };
}

export function formatScan(result: ScanResult): string {
  const lines = [`${String(result.filesScanned)} file(s) scanned · gitleaks: ${result.gitleaks}`];
  if (result.skippedSecretPaths.length > 0) {
    // Named, not silent: these files were deliberately not opened, and someone
    // reading a clean report deserves to know which paths it does not cover.
    lines.push(
      `${String(result.skippedSecretPaths.length)} credential path(s) not read: ${result.skippedSecretPaths.slice(0, 5).join(', ')}${result.skippedSecretPaths.length > 5 ? ', …' : ''}`,
    );
  }
  if (result.allowlistedPaths.length > 0) {
    // An exemption nobody can see is an exemption nobody reviews.
    lines.push(`${String(result.allowlistedPaths.length)} path(s) exempted by .gitleaks.toml`);
  }
  lines.push('', formatSecurityGate(result.gate));
  return lines.join('\n');
}

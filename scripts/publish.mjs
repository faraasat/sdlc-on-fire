#!/usr/bin/env node
/**
 * The publish step (P0-META-03, ADR-0033).
 *
 * `changeset publish` would be one line, and it is not used, for a reason worth
 * stating rather than discovering:
 *
 *   * Changesets detects pnpm and runs `pnpm publish`, which correctly rewrites
 *     `workspace:*` into real version ranges. Without that, `sdlc-on-fire`
 *     ships eight dependencies a consumer's package manager cannot resolve.
 *   * `pnpm publish` has no `--provenance`. ADR-0033 requires signed provenance
 *     so a consumer can verify a tarball came from this repository rather than
 *     from someone who guessed the package name.
 *
 * Neither publisher does both. So this packs with pnpm — which produces a
 * tarball whose ranges are already correct — and uploads that tarball with npm,
 * which signs it. Verified: `pnpm pack` emits `"@sdlc-on-fire/core": "0.1.0"`
 * where the source says `workspace:*`, and `npm publish <tarball>` accepts a
 * prepacked archive.
 *
 * Output format is not cosmetic: `changesets/action` reads stdout for
 * `New tag: <name>@<version>` to decide what to tag and whether anything was
 * published at all. A silent success here is a release with no git tags.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyTarball } from './verify-package.mjs';

const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

/** Every non-private workspace package. */
function publishablePackages(cwd) {
  return JSON.parse(run('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], { cwd }))
    .filter((pkg) => pkg.private !== true && pkg.path !== cwd)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether this exact version is already on the registry.
 *
 * Publishing is not idempotent — npm rejects a duplicate version with an error
 * that reads like a failure. A re-run after a partial release (network drop
 * between package four and package five) has to be able to finish the job
 * rather than abort on the four that already landed.
 */
function alreadyPublished(name, version) {
  try {
    run('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Which npm dist-tag a version belongs on.
 *
 * npm defaults to `latest` when no tag is given, and `latest` is what a bare
 * `npm install sdlc-on-fire` resolves to. Publishing `0.1.0-alpha.0` without a
 * tag would therefore serve a prerelease to everyone who typed the plain
 * install command — the opposite of what a prerelease is for, and not fixable
 * afterwards without publishing something else on top.
 *
 * So the tag is derived from the version rather than passed in: a version with
 * a prerelease component goes to `next`, everything else to `latest`. Nothing
 * to remember at release time, and no flag to forget.
 */
export function distTagFor(version) {
  return String(version).includes('-') ? 'next' : 'latest';
}

/**
 * The npm publish flags for this environment.
 *
 * `--provenance` needs a CI runner npm can get an OIDC token from; on a laptop
 * it does not degrade, it **fails the publish**. That matters for exactly one
 * release: the first. Trusted Publishing is configured per package on npmjs.com
 * and a package that does not exist yet has no settings page, so the first
 * publish cannot come from CI — it comes from a maintainer's machine, where
 * `--provenance` cannot work.
 *
 * So provenance is attached when the environment can actually produce it, and
 * omitted with a printed warning when it cannot. The warning is the point: a
 * release silently missing its attestation looks exactly like one that has it,
 * and ADR-0033 wants provenance on every published artifact rather than on
 * every artifact anyone remembered to check.
 */
export function publishFlags(env = process.env) {
  const inCI = env['GITHUB_ACTIONS'] === 'true' || env['CI'] === 'true';
  return {
    provenance: inCI,
    flags: inCI ? ['--provenance', '--access', 'public'] : ['--access', 'public'],
  };
}

function main() {
  const cwd = process.cwd();
  // `--dry-run` rehearses the whole release: packs, verifies, and asks npm to
  // validate each tarball, uploading nothing. Publishing is irreversible per
  // package and a version number is burned forever, so the run that proves the
  // pipeline works must not be the run that commits to it.
  const dryRun = process.argv.includes('--dry-run');
  const packages = publishablePackages(cwd);

  if (dryRun) process.stdout.write('DRY RUN — nothing will be uploaded.\n\n');

  if (packages.length === 0) {
    // Discovery returning nothing is a broken script, not an empty release.
    process.stderr.write('No publishable packages found — refusing to report success.\n');
    process.exit(1);
  }

  const expectedVersion = packages.find((pkg) => pkg.name === 'sdlc-on-fire')?.version;
  const out = mkdtempSync(path.join(tmpdir(), 'publish-'));
  const published = [];

  try {
    // Packed and verified as a set *before* anything is uploaded. Publishing is
    // irreversible per package, so the last moment a bad release can be stopped
    // whole is before the first upload — not between the third and the fourth.
    const staged = packages.map((pkg) => {
      run('pnpm', ['pack', '--pack-destination', out], { cwd: pkg.path });
      const tarball = path.join(
        out,
        `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`,
      );
      return { ...pkg, tarball, result: verifyTarball(tarball, { expectedVersion }) };
    });

    const broken = staged.filter((pkg) => pkg.result.findings.length > 0);
    if (broken.length > 0) {
      for (const pkg of broken) {
        for (const finding of pkg.result.findings) process.stderr.write(`  ${finding}\n`);
      }
      process.stderr.write('\nRefusing to publish: the artifacts above would not install.\n');
      process.exit(1);
    }

    for (const pkg of staged) {
      if (alreadyPublished(pkg.name, pkg.version)) {
        process.stdout.write(`= ${pkg.name}@${pkg.version} already on the registry, skipping\n`);
        continue;
      }

      // `--tag` is always passed: omitting it means `latest`, which would serve
      // a prerelease to every plain `npm install`.
      const tag = distTagFor(pkg.version);
      const { provenance, flags } = publishFlags();
      // `--provenance` and `--dry-run` cannot be combined: npm refuses to mint
      // an attestation for an upload that will not happen. The rehearsal drops
      // provenance, which is the one difference between it and the real run.
      const publishArgs = dryRun
        ? ['publish', pkg.tarball, '--access', 'public', '--tag', tag, '--dry-run']
        : ['publish', pkg.tarball, ...flags, '--tag', tag];
      // A real publish shows everything npm says; the rehearsal drops stdout
      // because it prints the full tarball manifest nine times over, which
      // buries the one line per package that actually matters. Stderr is
      // inherited either way — a failure is never the quiet one.
      run('npm', publishArgs, {
        stdio: dryRun ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
      });

      if (dryRun) {
        process.stdout.write(`✓ ${pkg.name}@${pkg.version} would publish to "${tag}"\n`);
        published.push(pkg);
        continue;
      }

      // The line `changesets/action` parses. Emitted per package, after that
      // package is actually on the registry — never in advance.
      process.stdout.write(`New tag: ${pkg.name}@${pkg.version}\n`);
      process.stdout.write(`  published to dist-tag "${tag}"\n`);
      if (!provenance) {
        process.stdout.write(
          '  ⚠ published WITHOUT provenance — not running in CI, so npm cannot mint an\n' +
            '    OIDC attestation. Expected for the first release only; every release\n' +
            '    after Trusted Publishing is configured runs in CI and is signed.\n',
        );
      }
      published.push(pkg);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${String(published.length)} of ${String(packages.length)} package(s) ${dryRun ? 'would publish' : 'published'} at ${String(expectedVersion)}\n`,
  );
}

/**
 * Only publish when run as a script.
 *
 * Without this, `import { distTagFor } from './publish.mjs'` — which the test
 * beside this file does — executes `main()` on import and attempts a real
 * release. Same shape as the bug the CLI entry point carried: a module that
 * does its work at import time is a module nothing can safely test.
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) main();

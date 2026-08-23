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
import semver from 'semver';
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
 * that reads like a failure. A re-run after a partial release has to be able to
 * finish the job rather than abort on the packages that already landed. That is
 * not a hypothetical: an account with 2FA on publishing gets `EOTP` partway
 * through, and the fix is to re-run, so this guard is on the recovery path of
 * every interactive release rather than an edge case.
 *
 * It rests on one non-obvious npm behaviour, checked against the live registry
 * rather than assumed: `npm view <pkg>@<version> version` exits **1** when the
 * package exists but that version does not. The plausible-and-wrong reading is
 * that npm treats a version that matches nothing on a known package as an empty
 * result and exits 0 — which would make this return `true` for every package
 * and turn the release into a silent no-op that reports success. It does not;
 * both a missing version and a missing package exit non-zero.
 *
 * `exec` is injected so that behaviour can be pinned by a test. Shelling out to
 * the real registry to prove a skip rule works is not a test, it is a network
 * call — and an unexercised guard is indistinguishable from a passing one.
 */
export function alreadyPublished(name, version, exec = run) {
  try {
    exec('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
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
 *
 * **What this cannot do, and the policy that covers the gap.** npm sets
 * `latest` on a package's *first* publish regardless of `--tag`: there is no
 * `latest` yet, so the registry creates one pointing at whatever was uploaded.
 * Checked against the live registry rather than reasoned about — all nine
 * packages went up at `0.1.0-alpha.0` with `--tag next` already in this script,
 * and every one of them came back `latest: 0.1.0-alpha.0`. `distTagFor` was
 * right and the tag landed anyway.
 *
 * Tagging correctly cannot undo that, because the wrong tag is already there.
 * So while a package has **no stable release at all**, the policy is that
 * `latest` tracks the newest prerelease, moved forward after each publish by
 * `shouldAdvanceLatest` + `advanceLatest`.
 *
 * The alternative — leave `latest` where the first publish put it and only warn
 * — was rejected on the arithmetic. Once `latest` exists and points at a
 * prerelease, the choice is no longer "prerelease or not"; that was lost at
 * first publish, and deleting the tag is worse still, since `latest` is by
 * definition what a bare `npm install <pkg>` resolves to. The choice is *which*
 * prerelease, and oldest-versus-newest is not a close call: same category of
 * risk, strictly fewer known defects. `0.1.0-alpha.1` exists precisely because
 * `0.1.0-alpha.0`'s `sdlc tiers` reports a passing test suite it never ran —
 * and for the eight days between them, `npm install sdlc-on-fire` served the
 * version with the false report in it.
 *
 * ADR-0033's intent — a bare install must not resolve to a prerelease — is
 * unachievable until a stable version exists, and is satisfied automatically
 * the moment one does: `distTagFor` sends it to `latest` and
 * `shouldAdvanceLatest` switches off permanently. Until then, second-best.
 */
export function distTagFor(version) {
  return String(version).includes('-') ? 'next' : 'latest';
}

/**
 * What dist-tags and versions the registry currently holds for a package.
 *
 * One `npm view` call for both fields, because the decision below needs them
 * together: `dist-tags.latest` says where a bare `npm install` lands today, and
 * `versions` says whether a stable release exists to own that tag.
 *
 * Two npm shapes worth naming, both checked against the live registry. The
 * field is `dist-tags`, with a hyphen, so it cannot be read as a plain property
 * name — a `view.distTags` typo returns `undefined` and silently disables this
 * whole path with nothing failing. And npm's `--json` shape depends on how many
 * fields are asked for: one field collapses to the bare value, so
 * `npm view <pkg> versions --json` prints the array itself, while two fields
 * return an object keyed by field name. The two-field call below is therefore
 * load-bearing, and `versions` is normalised rather than trusted — dropping a
 * field from that argument list would otherwise turn `versions` into something
 * `.some()` throws on, inside a release, after the upload.
 *
 * Returns `null` when the registry cannot answer. A lookup failure is not a
 * reason to fail a release whose packages are already uploaded.
 */
export function registryTags(name, exec = run) {
  try {
    const view = JSON.parse(
      exec('npm', ['view', name, 'dist-tags', 'versions', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const versions = view['versions'] ?? [];
    return {
      distTags: view['dist-tags'] ?? {},
      versions: Array.isArray(versions) ? versions : [versions],
    };
  } catch {
    return null;
  }
}

/**
 * Whether `latest` should be moved forward onto the version just published.
 *
 * The policy above, as one predicate, deliberately conservative: every
 * condition has to hold, and the only thing it can ever authorise is moving
 * `latest` *forward* onto a prerelease of a package that has never had a stable
 * release.
 *
 *   * A stable version anywhere in the package's history means `latest` is
 *     already spoken for. `distTagFor` routes stable versions onto it and
 *     prereleases away from it; from the first stable release onward this
 *     function is off for good.
 *   * `latest` has to be pointing at a *lower* version. Moving it backwards is
 *     the same defect aimed the other way, and there is a real shape that would
 *     do it: a backport publishing `0.1.1-alpha.0` after `0.2.0-alpha.0` is
 *     already out.
 *
 * `semver` does the comparing rather than a string compare or a parser written
 * here. `alpha.10` is newer than `alpha.9` and lexicographically smaller, and
 * the ordering of the default install target is not the place to discover that.
 * It costs nothing: 7.8.5 is already in the lockfile via `@changesets/cli`, so
 * declaring it direct adds an edge, not a download.
 */
export function shouldAdvanceLatest(version, snapshot) {
  if (snapshot === null) return false;

  const latest = snapshot.distTags['latest'];
  // Nothing observed to correct. A package with no `latest` at all is a state
  // only a manual `npm dist-tag rm` produces; guessing at it is out of scope.
  if (latest === undefined || latest === version) return false;

  // A stable version owns `latest` — whether it is the one just published, the
  // one the tag already points at, or one sitting anywhere in the history.
  if (semver.prerelease(version) === null) return false;
  if (semver.prerelease(latest) === null) return false;
  if (snapshot.versions.some((v) => semver.valid(v) !== null && semver.prerelease(v) === null)) {
    return false;
  }

  return semver.gt(version, latest);
}

/** The command a human runs to do this by hand. Printed whenever automation cannot. */
export function distTagAddCommand(name, version) {
  return `npm dist-tag add ${name}@${version} latest`;
}

/**
 * Move `latest` forward, or report exactly how to.
 *
 * `npm dist-tag add` reaches the registry through the same `otplease()` wrapper
 * as `npm publish` — read out of the npm CLI source, where the dist-tag PUT and
 * the publish request are wrapped identically — so on an account with 2FA on
 * auth-and-writes it needs a one-time password. Two consequences:
 *
 *   * stdin is inherited, so npm can prompt for the OTP the way it does during
 *     publish. With stdin ignored the call dies on a closed channel, which is
 *     the bug `publishStdio` already documents one function up.
 *   * a failure here **never fails the release.** This runs after the tarball is
 *     on the registry, where the irreversible part is done; a non-zero exit
 *     would report a failed release that actually succeeded, and would do it on
 *     the OTP path — the likeliest failure on a 2FA account, and one an
 *     unattended run cannot satisfy at all. So it degrades to a printed command
 *     rather than an exit code.
 */
export function advanceLatest(name, version, exec = run) {
  try {
    exec('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    return { moved: true, reason: null };
  } catch (error) {
    return { moved: false, reason: error instanceof Error ? error.message : String(error) };
  }
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

/**
 * How `npm publish`'s streams are wired.
 *
 * **stdin must be inherited on a real publish.** An account with 2FA on
 * publishing gets `EOTP` and npm offers to complete the flow interactively — a
 * one-time password prompt, or a browser round-trip it waits on. With stdin
 * ignored npm cannot ask, so the publish dies on the first package with an
 * error that reads like a configuration problem and is actually a closed
 * channel. Found the hard way: `--dry-run` needs no OTP and passed cleanly,
 * then the real run failed on package one of nine.
 *
 * The rehearsal suppresses stdout because it prints a full tarball manifest
 * nine times over, burying the one line per package that matters. The real run
 * inherits everything. Stderr is inherited in both — a failure is never the
 * quiet one.
 */
export function publishStdio(dryRun) {
  return dryRun ? ['ignore', 'ignore', 'inherit'] : ['inherit', 'inherit', 'inherit'];
}

/**
 * Refuse to start when npm does not know who you are.
 *
 * npm answers an unauthenticated `PUT` to an existing package with **404 Not
 * Found**, not 401 — so an expired token surfaces as "the requested resource
 * could not be found or you do not have permission to access it" about a
 * package that plainly exists and that you own. It is one of the least
 * guessable errors in the toolchain, and it happened here on 2026-08-23 after
 * a token quietly expired.
 *
 * Checked once, before the first tarball is built, because the alternative is
 * discovering it after a full workspace build.
 *
 * A registry that cannot be reached at all is deliberately *not* fatal: the
 * per-package publish will fail with its own message, and refusing to start
 * because a network blip broke one status call would be worse than the problem.
 */
function assertAuthenticated(dryRun) {
  let who;
  try {
    who = execFileSync('npm', ['whoami'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const text = String(cause?.stderr ?? cause?.message ?? '');
    if (!/E401|Unauthorized|ENEEDAUTH/i.test(text)) return; // not an auth problem
    process.stderr.write(
      'npm does not know who you are — run `npm login` and try again.\n\n' +
        '  Why this is worth saying explicitly: npm answers an unauthenticated PUT to an\n' +
        '  existing package with 404 Not Found rather than 401, so without this check the\n' +
        '  failure reads as "package not found" for a package you own and published before.\n',
    );
    process.exit(1);
  }
  if (who === '') {
    process.stderr.write('npm returned no username — run `npm login` and try again.\n');
    process.exit(1);
  }
  process.stdout.write(
    `npm user: ${who}${dryRun ? ' (dry run — nothing will be uploaded)' : ''}\n\n`,
  );
}

function main() {
  const cwd = process.cwd();
  // `--dry-run` rehearses the whole release: packs, verifies, and asks npm to
  // validate each tarball, uploading nothing. Publishing is irreversible per
  // package and a version number is burned forever, so the run that proves the
  // pipeline works must not be the run that commits to it.
  const dryRun = process.argv.includes('--dry-run');

  // `--check-auth` is the whole run: verify npm knows who you are and stop.
  // Wired ahead of the build in the `release` script, because a token that
  // expired is worth discovering in two seconds rather than after ten packages
  // have been compiled.
  if (process.argv.includes('--check-auth')) {
    assertAuthenticated(false);
    return;
  }

  const packages = publishablePackages(cwd);

  if (dryRun) process.stdout.write('DRY RUN — nothing will be uploaded.\n\n');

  // Before anything is packed: an expired token otherwise surfaces as a 404 on
  // the first upload, after a full workspace build.
  assertAuthenticated(dryRun);

  if (packages.length === 0) {
    // Discovery returning nothing is a broken script, not an empty release.
    process.stderr.write('No publishable packages found — refusing to report success.\n');
    process.exit(1);
  }

  const expectedVersion = packages.find((pkg) => pkg.name === 'sdlc-on-fire')?.version;
  const out = mkdtempSync(path.join(tmpdir(), 'publish-'));
  const published = [];
  // Packages whose `latest` still needs moving by hand — collected so the
  // instruction can be repeated once at the end, where nine packages' worth
  // of npm output has not yet scrolled it away.
  const needsManualLatest = [];

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
      run('npm', publishArgs, { stdio: publishStdio(dryRun) });

      if (dryRun) {
        process.stdout.write(`✓ ${pkg.name}@${pkg.version} would publish to "${tag}"\n`);
        const rehearsal = registryTags(pkg.name);
        if (shouldAdvanceLatest(pkg.version, rehearsal)) {
          process.stdout.write(
            `  … and would move dist-tag "latest" from ${String(rehearsal.distTags['latest'])} to ${pkg.version}\n`,
          );
        }
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

      // npm put `latest` on the very first publish regardless of `--tag`, so
      // correcting it is a post-publish step, not a flag — see distTagFor.
      const snapshot = registryTags(pkg.name);
      if (shouldAdvanceLatest(pkg.version, snapshot)) {
        process.stdout.write(
          `  ⚠ dist-tag "latest" still points at ${String(snapshot.distTags['latest'])}, which is\n` +
            `    what a bare \`npm install ${pkg.name}\` resolves to. Moving it forward.\n`,
        );
        const { moved, reason } = advanceLatest(pkg.name, pkg.version);
        if (moved) {
          process.stdout.write(`  ✓ dist-tag "latest" now points at ${pkg.version}\n`);
        } else {
          needsManualLatest.push(pkg);
          process.stdout.write(
            `  ⚠ could not move "latest": ${String(reason).split('\n')[0]}\n` +
              `    The package is published; only the tag is behind. Run:\n` +
              `      ${distTagAddCommand(pkg.name, pkg.version)}\n`,
          );
        }
      }
      published.push(pkg);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  process.stdout.write(
    `\n${String(published.length)} of ${String(packages.length)} package(s) ${dryRun ? 'would publish' : 'published'} at ${String(expectedVersion)}\n`,
  );
  if (needsManualLatest.length > 0) {
    // Loud, last, and copy-pasteable. Until these run, a bare `npm install`
    // keeps serving the older prerelease — the exact failure this release fixed.
    process.stdout.write(
      `\n⚠ dist-tag "latest" was NOT moved for ${String(needsManualLatest.length)} package(s).\n` +
        '  A bare `npm install` still resolves to an older prerelease until it is.\n' +
        '  Run (each needs an --otp value if 2FA is on auth-and-writes):\n\n',
    );
    for (const pkg of needsManualLatest) {
      process.stdout.write(`    ${distTagAddCommand(pkg.name, pkg.version)}\n`);
    }
    process.stdout.write('\n');
  }
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

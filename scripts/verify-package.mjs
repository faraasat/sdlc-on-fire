#!/usr/bin/env node
/**
 * Pre-publish verification (P2-META-01).
 *
 * Publishing is the one action in this repo that cannot be undone. npm's
 * unpublish window is 72 hours, and a version number, once used, is burned
 * forever. So the checks that matter run *before* the tarball leaves, on the
 * artifact that will actually be uploaded — not on the working tree, which is
 * not what consumers get.
 *
 * The defect this exists for was real. `release.yml` published only
 * `packages/cli`, while `sdlc-on-fire` declares eight `workspace:*`
 * dependencies on sibling packages. That publishes a package to npm whose
 * dependencies do not exist there: `npm install sdlc-on-fire` fails on the
 * first resolve, and no test in this repo would have noticed, because every one
 * of them imports from the workspace where those packages are right there.
 *
 * Each check below is something a green suite is structurally blind to.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Reads a file out of a tarball without unpacking the whole thing. */
function readFromTarball(tarball, member) {
  return execFileSync('tar', ['-xzOf', tarball, `package/${member}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function listTarball(tarball) {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);
}

/**
 * Verifies one packed tarball.
 *
 * Returns findings rather than throwing, so a run reports everything wrong with
 * every package instead of stopping at the first — the difference between one
 * fix and a sequence of re-runs.
 */
export function verifyTarball(tarball, { expectedVersion } = {}) {
  const findings = [];
  const manifest = JSON.parse(readFromTarball(tarball, 'package.json'));
  const entries = listTarball(tarball);

  // 1. Workspace protocol must be gone. This is the defect that prompted the
  //    script: `workspace:*` is meaningless to a consumer's package manager.
  for (const group of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[group] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        findings.push(
          `${manifest.name}: ${group}.${name} is still "${range}" — a consumer's package manager cannot resolve that`,
        );
      }
    }
  }

  // 2. Every `@sdlc-on-fire/*` dependency must be published in this same run.
  //    Lockstep `fixed` versioning means they move together; a sibling pinned
  //    to a version that was never published is the same failure wearing a real
  //    version number.
  if (expectedVersion !== undefined) {
    if (manifest.version !== expectedVersion) {
      findings.push(
        `${manifest.name}: version ${manifest.version} does not match the lockstep version ${expectedVersion}`,
      );
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@sdlc-on-fire/') && !range.includes(expectedVersion)) {
        findings.push(
          `${manifest.name}: depends on ${name}@${range}, but this release publishes ${expectedVersion}`,
        );
      }
    }
  }

  // 3. The build output has to be in the tarball. `files` and `.npmignore`
  //    disagree in ways that are invisible until an install produces a package
  //    with a package.json and nothing else.
  if (!entries.some((entry) => entry.startsWith('package/dist/'))) {
    findings.push(`${manifest.name}: no dist/ in the tarball — nothing would be importable`);
  }

  // 4. Declared entry points must exist inside the tarball. A `main` pointing
  //    at a file that was not packed is an install that succeeds and an import
  //    that does not.
  for (const [field, value] of [
    ['main', manifest.main],
    ['module', manifest.module],
    ['types', manifest.types],
  ]) {
    if (typeof value !== 'string') continue;
    const member = `package/${value.replace(/^\.\//, '')}`;
    if (!entries.includes(member)) {
      findings.push(`${manifest.name}: ${field} points at ${value}, which is not in the tarball`);
    }
  }

  // 5. A `bin` must be executable as a script. A duplicate shebang once made
  //    dist/index.js a syntax error while 320 unit tests stayed green, because
  //    every one of them imported the module instead of running the artifact.
  for (const [command, target] of Object.entries(manifest.bin ?? {})) {
    const member = `package/${String(target).replace(/^\.\//, '')}`;
    if (!entries.includes(member)) {
      findings.push(`${manifest.name}: bin "${command}" points at ${target}, not in the tarball`);
      continue;
    }
    const source = readFromTarball(tarball, String(target).replace(/^\.\//, ''));
    const shebangs = source.split('\n').filter((line) => line.startsWith('#!')).length;
    if (shebangs === 0) {
      findings.push(`${manifest.name}: bin "${command}" has no shebang`);
    } else if (shebangs > 1) {
      findings.push(
        `${manifest.name}: bin "${command}" has ${shebangs} shebangs — only the first line is one, the rest are syntax errors`,
      );
    }
  }

  // 6. Metadata npm shows on the package page. Cheap to get wrong, and it is
  //    the first thing a person deciding whether to trust this package reads.
  for (const field of ['license', 'repository', 'description']) {
    if (manifest[field] === undefined) {
      findings.push(`${manifest.name}: no ${field} — npm shows this on the package page`);
    }
  }

  return { name: manifest.name, version: manifest.version, findings };
}

/** Packs every publishable workspace package and verifies the tarballs. */
export function verifyWorkspace({ cwd = process.cwd(), expectedVersion } = {}) {
  const packages = JSON.parse(
    execFileSync('pnpm', ['list', '--recursive', '--depth', '-1', '--json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  ).filter((pkg) => pkg.private !== true && pkg.path !== cwd);

  const out = mkdtempSync(path.join(tmpdir(), 'verify-pkg-'));
  try {
    return packages.map((pkg) => {
      try {
        execFileSync('pnpm', ['pack', '--pack-destination', out], {
          cwd: pkg.path,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        // A package that cannot even be packed is a finding, not a stack trace.
        // pnpm refuses outright when a workspace dependency is missing, and the
        // first version of this script surfaced that as an unhandled exception
        // — which reports one broken package by hiding the other eight.
        const detail = String(error?.stderr ?? error?.message ?? error)
          .split('\n')
          .find((line) => line.trim() !== '');
        return {
          name: pkg.name,
          version: pkg.version,
          findings: [`${pkg.name}: cannot be packed — ${detail ?? 'pnpm pack failed'}`],
        };
      }

      const file = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
      return verifyTarball(path.join(out, file), { expectedVersion });
    });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const version = JSON.parse(
    readFileSync(path.join(root, 'packages/cli/package.json'), 'utf8'),
  ).version;

  const results = verifyWorkspace({ cwd: root, expectedVersion: version });
  const failed = results.filter((result) => result.findings.length > 0);

  for (const result of results) {
    const mark = result.findings.length === 0 ? '✓' : '✗';
    process.stdout.write(`${mark} ${result.name}@${result.version}\n`);
    for (const finding of result.findings) process.stdout.write(`    ${finding}\n`);
  }

  if (results.length === 0) {
    // An empty run is not a passing run. If package discovery broke, this would
    // otherwise report success having checked nothing.
    process.stdout.write('\nNo publishable packages found — nothing was verified.\n');
    process.exit(1);
  }

  process.stdout.write(
    `\n${String(results.length - failed.length)}/${String(results.length)} package(s) ready to publish\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

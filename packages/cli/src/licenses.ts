import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import {
  assessLicense,
  evaluateLicenseGate,
  type LicenseAssessment,
  type LicenseGateResult,
} from '@sdlc-on-fire/core';

/**
 * `sdlc licenses` (P2-SEC-08).
 *
 * Reads licenses from **installed** packages rather than from a registry API.
 *
 * That is the deliberate choice: `node_modules/<pkg>/package.json` is the
 * license of the code that will actually run, and a registry answer describes
 * whatever version the registry has now. It also means this works offline, in
 * CI, and against private registries — the places a license question is most
 * likely to be asked and least likely to have a network path to deps.dev.
 *
 * The cost is that it needs an install first, which is stated in the output
 * rather than left for someone to infer from an empty result.
 */

export interface LicenseCheckResult {
  readonly root: string;
  readonly packagesFound: number;
  readonly projectLicense: string;
  readonly gate: LicenseGateResult;
}

interface PackageManifest {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
}

/** Normalises the three shapes npm has used for `license` over the years. */
function licenseOf(manifest: PackageManifest): string | undefined {
  if (typeof manifest.license === 'string') return manifest.license;
  if (typeof manifest.license === 'object' && typeof manifest.license.type === 'string') {
    return manifest.license.type;
  }
  // The deprecated array form. Multiple entries were a choice, so they join
  // with OR — reading them as a conjunction would flag dual-licensed packages
  // that a project may legitimately take the permissive side of.
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((l) => l.type)
      .filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return undefined;
}

async function readManifest(file: string): Promise<PackageManifest | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageManifest;
  } catch {
    return null;
  }
}

/**
 * Whether a `node_modules` entry is a package directory.
 *
 * **A symlink counts.** pnpm — and npm/yarn workspaces — install packages as
 * symlinks into a content-addressed store, and `Dirent.isDirectory()` is false
 * for a symlink no matter what it points at. Filtering on it alone made this
 * command report "no installed packages" for an entire pnpm monorepo, which is
 * the layout of this repo and of most projects it will run against.
 *
 * The honest empty-result message meant it never claimed those licenses were
 * fine — but a check that answers "nothing to check" on every real project is
 * a check that never runs.
 */
async function isPackageDirectory(fullPath: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  // `stat` follows the link; a dangling one throws and is not a package.
  return fs
    .stat(fullPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

/**
 * Every installed package, including scoped ones.
 *
 * Walks nested `node_modules` too: a transitive dependency that did not hoist
 * is still code that ships, and a scan reading only the top level reports on
 * whatever happened to hoist — not a property anyone chose.
 */
export async function installedPackages(
  root: string,
  depth = 0,
  visited: Set<string> = new Set(),
): Promise<readonly { name: string; version: string | undefined; license: string | undefined }[]> {
  // Bounded so a pathological tree cannot walk forever; nesting this deep is
  // already unusual under a modern package manager.
  if (depth > 4) return [];

  const modules = path.join(root, 'node_modules');
  const entries = await fs.readdir(modules, { withFileTypes: true }).catch(() => []);
  const found: { name: string; version: string | undefined; license: string | undefined }[] = [];

  for (const entry of entries) {
    if (entry.name === '.bin') continue;

    // pnpm's content-addressed store. Every package the project resolves lives
    // here as `.pnpm/<name>@<version>/node_modules/<name>`, while the top level
    // holds symlinks to *direct* dependencies only. Skipping it limits the scan
    // to direct dependencies — and a GPL package pulled in three levels down is
    // precisely the one that surprises a team, since nobody chose it.
    if (entry.name === '.pnpm') {
      const store = path.join(modules, entry.name);
      const versions = await fs.readdir(store, { withFileTypes: true }).catch(() => []);
      for (const version of versions) {
        if (!(await isPackageDirectory(path.join(store, version.name), version))) continue;
        found.push(...(await installedPackages(path.join(store, version.name), depth, visited)));
      }
      continue;
    }

    if (!(await isPackageDirectory(path.join(modules, entry.name), entry))) continue;

    const directories = entry.name.startsWith('@')
      ? await Promise.all(
          (
            await fs
              .readdir(path.join(modules, entry.name), { withFileTypes: true })
              .catch(() => [])
          ).map(async (child) =>
            (await isPackageDirectory(path.join(modules, entry.name, child.name), child))
              ? path.join(entry.name, child.name)
              : null,
          ),
        ).then((names) => names.filter((name): name is string => name !== null))
      : [entry.name];

    for (const relative of directories) {
      const packageDir = path.join(modules, relative);
      // Symlinked stores make the tree a graph: two packages depending on the
      // same version link to one directory, and following both would walk it
      // twice — or, with a cycle, forever. Keyed on the resolved path, since
      // that is what makes two links the same package.
      const real = await fs.realpath(packageDir).catch(() => packageDir);
      if (visited.has(real)) continue;
      visited.add(real);

      const manifest = await readManifest(path.join(packageDir, 'package.json'));
      if (manifest !== null) {
        found.push({
          name: manifest.name ?? relative,
          version: manifest.version,
          license: licenseOf(manifest),
        });
      }
      found.push(...(await installedPackages(packageDir, depth + 1, visited)));
    }
  }

  return found;
}

export async function checkLicenses(
  root: string,
  options: { readonly projectLicense?: string | undefined } = {},
): Promise<LicenseCheckResult> {
  const own = await readManifest(path.join(root, 'package.json'));
  const projectLicense = options.projectLicense ?? licenseOf(own ?? {}) ?? 'MIT';

  const installed = await installedPackages(root);
  // One assessment per package name. A dependency present at three versions is
  // one licensing question, and three rows would read as three.
  const byName = new Map<string, string | undefined>();
  for (const pkg of installed) if (!byName.has(pkg.name)) byName.set(pkg.name, pkg.license);

  const assessments: LicenseAssessment[] = [...byName.entries()].map(([name, license]) =>
    assessLicense(name, license, projectLicense),
  );

  return {
    root,
    packagesFound: assessments.length,
    projectLicense,
    gate: evaluateLicenseGate(assessments),
  };
}

export function formatLicenses(result: LicenseCheckResult): string {
  const lines = [
    `${String(result.packagesFound)} installed package(s) · project license: ${result.projectLicense}`,
  ];

  if (result.packagesFound === 0) {
    // Said plainly. An empty result from an uninstalled tree looks exactly
    // like a clean bill of health, which is the failure this product keeps
    // refusing to ship.
    lines.push(
      '',
      'No installed packages were found, which means nothing was checked — not that',
      'every license is fine. Install dependencies first.',
    );
    return lines.join('\n');
  }

  lines.push('');
  if (result.gate.decision === 'clean') {
    lines.push('✓ every dependency license is compatible');
    return lines.join('\n');
  }

  lines.push(`⚠ ${String(result.gate.flagged.length)} license(s) need a human`);
  for (const reason of result.gate.reasons) lines.push(`  ${reason}`);
  lines.push(
    '',
    'These are flagged, not refused: whether a use creates a derived work depends',
    'on linking, process boundaries, and jurisdiction — which no table settles.',
  );
  return lines.join('\n');
}

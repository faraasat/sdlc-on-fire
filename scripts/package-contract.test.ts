import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The contract between published layers, asserted against **packed tarballs**
 * (P3-PKG-01).
 *
 * The source manifests say `workspace:^`, and that is not what ships. pnpm
 * rewrites workspace protocols at pack time, and the defect this guards only
 * exists after that rewrite — which is why every check we already had stayed
 * green while `sdlc-on-fire@0.1.0-alpha.0` shipped declaring
 * `"@sdlc-on-fire/core": "0.1.0-alpha.0"`, an exact pin. A user on that version
 * could not pick up a fixed `core` without all nine packages being republished.
 *
 * Two properties, and the second is the one a range alone does not give:
 *
 * **Ranged, not pinned.** An inter-layer dependency must admit a compatible
 * patch. An exact version turns nine independently publishable layers into one
 * lockstep artifact wearing nine names.
 *
 * **Exactly one `core`.** It is a `peerDependency` of every leaf layer rather
 * than a dependency, so a package manager installs one copy and warns rather
 * than silently resolving two. Two copies of `core` means two copies of every
 * Zod schema, and identity comparisons across them fail in ways that read as
 * data problems.
 */

const run = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const LEAF_PACKAGES = [
  'db',
  'daemon',
  'evidence',
  'agent-manager',
  'context',
  'storage',
  'importers',
] as const;

interface PackedManifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

let manifests: PackedManifest[] = [];
let workDir: string;

/**
 * Packs a package and reads the `package.json` that would actually be published.
 *
 * **`pnpm pack`, not `npm pack`, and the difference is the whole test.** `npm
 * pack` leaves `workspace:*` in the manifest verbatim; pnpm is what rewrites the
 * protocol to a concrete version, and the rewrite is where the exact pin comes
 * from. The first version of this guard used `npm pack` and passed cleanly
 * against the defective state — it was inspecting an artifact nobody ships.
 */
async function packedManifest(name: string): Promise<PackedManifest> {
  // Its own directory per package. Packing several into one and picking "the
  // new .tgz" races: the first version read a tarball another pack was still
  // writing, and `tar` reported truncated gzip input.
  const out = path.join(workDir, name);
  await fs.mkdir(out, { recursive: true });

  await run('pnpm', ['pack', '--pack-destination', out], {
    cwd: path.join(repoRoot, 'packages', name),
    maxBuffer: 20_000_000,
  });

  const tarball = (await fs.readdir(out)).find((entry) => entry.endsWith('.tgz')) ?? '';
  await run('tar', ['-xzf', path.join(out, tarball), '-C', out]);
  const raw = await fs.readFile(path.join(out, 'package', 'package.json'), 'utf8');
  return JSON.parse(raw) as PackedManifest;
}

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-pack-'));
  manifests = [];
  for (const name of ['cli', ...LEAF_PACKAGES]) {
    manifests.push(await packedManifest(name));
  }
}, 600_000);

afterAll(async () => {
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const internal = (deps: Record<string, string> | undefined): [string, string][] =>
  Object.entries(deps ?? {}).filter(([name]) => name.startsWith('@sdlc-on-fire/'));

describe('what actually ships', () => {
  it('packs every package', () => {
    expect(manifests).toHaveLength(LEAF_PACKAGES.length + 1);
  });

  it('never pins an inter-layer dependency to an exact version', () => {
    // The defect, stated as the property. An exact version turns nine
    // independently publishable layers into one lockstep artifact.
    const pinned: string[] = [];
    for (const manifest of manifests) {
      for (const [name, range] of [
        ...internal(manifest.dependencies),
        ...internal(manifest.peerDependencies),
      ]) {
        if (/^\d/.test(range)) pinned.push(`${manifest.name} pins ${name}@${range}`);
      }
    }
    expect(pinned).toEqual([]);
  });

  it('declares core as a peer on every leaf layer, not a dependency', () => {
    // A range alone does not stop two copies being installed. This does.
    const wrong: string[] = [];
    for (const manifest of manifests.filter((entry) => entry.name !== 'sdlc-on-fire')) {
      if (manifest.dependencies?.['@sdlc-on-fire/core'] !== undefined) {
        wrong.push(`${manifest.name} depends on core instead of peering it`);
      }
      if (manifest.peerDependencies?.['@sdlc-on-fire/core'] === undefined) {
        wrong.push(`${manifest.name} does not peer core`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('lets the CLI depend on core concretely, because something must provide it', () => {
    // The peer has to be satisfied by somebody. The application at the top of
    // the stack is that somebody; if it peered core too, nothing would install it.
    const cli = manifests.find((entry) => entry.name === 'sdlc-on-fire');
    expect(cli?.dependencies?.['@sdlc-on-fire/core']).toBeDefined();
  });

  it('keeps every internal range on the same major line', () => {
    // Mixed majors across layers is how a duplicate arrives even with peers:
    // two ranges that cannot both be satisfied by one copy.
    const majors = new Set<string>();
    for (const manifest of manifests) {
      for (const [, range] of [
        ...internal(manifest.dependencies),
        ...internal(manifest.peerDependencies),
      ]) {
        majors.add(range.replace(/^[\^~>=<\s]+/, '').split('.')[0] ?? '');
      }
    }
    expect(majors.size).toBeLessThanOrEqual(1);
  });
});

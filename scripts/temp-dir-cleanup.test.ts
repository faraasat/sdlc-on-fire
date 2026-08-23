import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every suite that makes a temp directory must remove it (P6-SURFACE-13).
 *
 * After the fix a full run leaks 12 directories instead of ~1,500, and all
 * twelve are `gitleaks-*` — made by the scanner binary itself in a child
 * process, not by any code this guard can see. Stated rather than silently
 * excluded: the number is not zero and pretending otherwise is how the next
 * leak hides behind this one.
 *
 * 108GB of abandoned PGlite data directories accumulated in the OS temp dir and
 * filled a 460GB disk. The failure that surfaced was not "out of space" — it was
 * ENOSPC arriving during test *collection*, which Vitest reports as a failed
 * file, naming a different innocent suite on each run. That reads exactly like
 * flake, and the first two things it cost were a timeout raise and an
 * afternoon.
 *
 * The worst offender had an `afterAll` that closed its database handles and
 * never touched the directory — the `root` was a local in `beforeEach` and was
 * not even captured. So "the file has an afterEach" is not the property worth
 * checking; "the file removes what it created" is.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

async function testFiles(dir: string, found: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await testFiles(full, found);
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('temp directory hygiene', () => {
  it('removes every temp directory it creates', async () => {
    const offenders: string[] = [];
    // `scripts/` too. The release guard and the package verifier both make
    // workspaces, and a glob covering only `packages/` would leave the tooling
    // exempt from the rule it enforces.
    const files = [
      ...(await testFiles(path.join(ROOT, 'packages'))),
      ...(await testFiles(path.join(ROOT, 'scripts'))),
    ];
    for (const file of files) {
      // This file names `mkdtemp` to describe the rule and makes no directory
      // of its own. Excluded by path rather than by making the pattern cleverer:
      // a guard that has to avoid matching its own prose is a guard whose
      // pattern will eventually stop matching something real.
      if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;

      const text = await fs.readFile(file, 'utf8');
      if (!text.includes('mkdtemp')) continue;
      // The directory has to be removed, recursively, somewhere in the file.
      // Closing a database handle is not removing its data directory — that was
      // the exact shape of the biggest leak.
      const removes = /\brm\(\s*[^)]*recursive:\s*true/s.test(text) || /rmSync\(/.test(text);
      if (!removes) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});

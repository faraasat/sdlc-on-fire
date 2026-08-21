import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every symbol a package README names in an import statement exists.
 *
 * Not a style check. Nine invented exports shipped in one README rewrite —
 * `runSandboxed` for `runGuarded`, `hybridRetrieve` for `hybridSearch`,
 * `detectFormats` for `detectAll`, and a constant attributed to the wrong
 * package. Every one of them was a *plausible* name for a thing that really
 * exists under a different one, which is why reading the file did not catch it
 * and why nothing else would have: a README is prose to every tool in this
 * repository, so a function that does not exist reads exactly like one that
 * does until somebody copies the line and it throws.
 *
 * The check is deliberately narrow — it verifies the symbols in `import { … }
 * from '@sdlc-on-fire/x'` blocks, which is the part a reader will paste. Prose
 * mentioning a function in backticks is not checked, because a README that
 * discusses a private helper by name is doing something legitimate.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(here, '..', 'packages');

/** `import { a, b as c, type D } from '@sdlc-on-fire/pkg';` → {pkg: [a, b]}. */
function importedSymbols(markdown: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /import\s*\{([^}]+)\}\s*from\s*'(@sdlc-on-fire\/[a-z-]+)'/g;

  for (const match of markdown.matchAll(pattern)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      // `type X` is erased at runtime, so it is not on the module object.
      .filter((entry) => entry !== '' && !entry.startsWith('type '))
      // `a as b` — the export is `a`.
      .map((entry) => (entry.split(/\s+as\s+/)[0] ?? entry).trim());
    const pkg = match[2] ?? '';
    found.set(pkg, [...(found.get(pkg) ?? []), ...names]);
  }
  return found;
}

async function readmes(): Promise<{ file: string; text: string }[]> {
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const out: { file: string; text: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(packagesDir, entry.name, 'README.md');
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text !== null) out.push({ file: `packages/${entry.name}/README.md`, text });
  }
  return out;
}

describe('README imports resolve', () => {
  it('finds a README for every package', async () => {
    // A package published to npm with no README shows an empty page there.
    expect((await readmes()).length).toBeGreaterThanOrEqual(9);
  });

  it('names only symbols the package actually exports', async () => {
    const problems: string[] = [];

    for (const { file, text } of await readmes()) {
      for (const [pkg, names] of importedSymbols(text)) {
        const mod = (await import(pkg)) as Record<string, unknown>;
        for (const name of names) {
          if (!(name in mod)) problems.push(`${file}: ${pkg} does not export "${name}"`);
        }
      }
    }

    expect(problems).toEqual([]);
  }, 60_000);

  it('parses a realistic import block', () => {
    // The parser is the part that can be wrong quietly: if it matched nothing,
    // the check above would pass on a README full of invented names.
    const symbols = importedSymbols(
      "import { alpha, beta as gamma, type Delta } from '@sdlc-on-fire/core';",
    );
    expect(symbols.get('@sdlc-on-fire/core')).toEqual(['alpha', 'beta']);
  });

  it('finds the imports that are actually in the READMEs', async () => {
    // Same hazard, asserted against the real files rather than a fixture.
    const total = (await readmes())
      .map(({ text }) => [...importedSymbols(text).values()].flat().length)
      .reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(20);
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No source file contains a NUL byte.
 *
 * Not a hypothetical. One reached `packages/core/src/mcp-client.ts` inside a
 * template literal, and every check in this repository stayed green: TypeScript
 * accepts it as an ordinary character, the build emitted it, and the tests
 * passed because the value was merely *consistent* rather than correct.
 *
 * What it did break was the tooling that had to go quiet to break. `grep`
 * classifies a file containing a NUL as binary and skips it **without saying
 * so** — so every search over that file silently returned nothing, and the
 * only symptom was a `grep` that found no match in a file that plainly
 * contained one. A defect whose signature is a tool reporting an empty result
 * is one that can sit in a repository indefinitely.
 *
 * So it gets a check. Cheap, exhaustive, and it fails loudly at the one moment
 * the byte is easy to remove.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo', '.sdlcof']);
const TEXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.json', '.md', '.yaml', '.yml']);

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (TEXT.has(path.extname(entry.name))) yield full;
  }
}

describe('source hygiene', () => {
  it('has no NUL byte in any text file', async () => {
    const offenders: string[] = [];
    for await (const file of sources(ROOT)) {
      if ((await fs.readFile(file)).includes(0)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  }, 120_000);
});

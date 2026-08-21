import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P3-UI-02 — the firewall as a dependency direction (ADR-0016).
 *
 * `context-provenance` stops UI *values* reaching a context pack. This stops UI
 * *code* reaching the daemon at all, which is the version that cannot be
 * argued with: if nothing on the agent side can import the browser's state,
 * there is no path for browser state to become an agent's context, whatever
 * anybody writes later.
 *
 * The direction is one-way by design. The UI imports core; nothing imports the
 * UI.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Packages on the agent side of the firewall. */
const AGENT_SIDE = [
  'core',
  'db',
  'daemon',
  'context',
  'evidence',
  'storage',
  'agent-manager',
  'importers',
];

async function sourceFiles(pkg: string): Promise<string[]> {
  const root = path.join(REPO, 'packages', pkg, 'src');
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  }
  await walk(root);
  return found;
}

describe('the agent-context firewall', () => {
  it('lets nothing on the agent side import the UI', async () => {
    const offenders: string[] = [];
    for (const pkg of AGENT_SIDE) {
      for (const file of await sourceFiles(pkg)) {
        const text = await fs.readFile(file, 'utf8');
        if (
          /from\s+['"]@sdlc-on-fire\/ui/.test(text) ||
          /import\(['"]@sdlc-on-fire\/ui/.test(text)
        ) {
          offenders.push(path.relative(REPO, file));
        }
      }
    }
    expect(offenders, 'agent-side code must not import the UI').toEqual([]);
  });

  it('keeps the UI out of every agent-side package manifest', async () => {
    // The import check above only sees code that exists now. A dependency
    // declared in package.json is the thing that makes the import *possible*,
    // and it is what a reviewer would miss.
    const offenders: string[] = [];
    for (const pkg of AGENT_SIDE) {
      const manifestPath = path.join(REPO, 'packages', pkg, 'package.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        if (manifest[field]?.['@sdlc-on-fire/ui'] !== undefined) offenders.push(`${pkg}: ${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('confirms the UI does depend on core, so the direction is real and not vacuous', async () => {
    // Without this, deleting every dependency would make the two tests above
    // pass while proving nothing.
    const manifest = JSON.parse(
      await fs.readFile(path.join(REPO, 'packages', 'ui', 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const declared =
      manifest['dependencies']?.['@sdlc-on-fire/core'] ??
      manifest['peerDependencies']?.['@sdlc-on-fire/core'];
    expect(declared).toBeDefined();
  });

  it('keeps the UI reading core through the browser entry only', async () => {
    // The Node barrel pulls in `node:path` and `node:crypto`, which a bundler
    // stubs — so importing it builds fine and throws in a user's browser. The
    // browser entry makes that a build error instead.
    const offenders: string[] = [];
    for (const file of await sourceFiles('ui')) {
      const text = await fs.readFile(file, 'utf8');
      if (/from\s+['"]@sdlc-on-fire\/core['"]/.test(text))
        offenders.push(path.relative(REPO, file));
    }
    expect(offenders, 'import @sdlc-on-fire/core/browser instead').toEqual([]);
  });
});

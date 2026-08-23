import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { dbDown, dbUp, formatDbDown, formatDbUp } from './db-lifecycle.js';

/**
 * `sdlc db:up` / `db:down` (P6-SURFACE-02).
 *
 * Against a real workspace and a real PGlite, because the properties under test
 * are "did the store actually appear" and "is the lock actually gone".
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
const madeDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of madeDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true, ...RM_RETRY }).catch(() => undefined);
  }
});

async function workspace(): Promise<string> {
  const root = await fs.realpath(await tempDir('sdlcof-dbup-'));
  await init(root, { database: 'skip' });
  return root;
}

describe('db:up', () => {
  it('creates and migrates the store, and says it created it', async () => {
    // "The database is up" and "the database has the shape this build expects"
    // are the same claim to anyone reading the word, so migrations run here
    // rather than being left to the first command that happens to need a table.
    const root = await workspace();
    const first = await dbUp(root);
    expect(first.mode).toBe('pglite');
    expect(first.created).toBe(true);
    expect(first.migrations).toBeGreaterThan(0);
    expect(formatDbUp(first)).toContain('created');
  }, 120_000);

  it('is idempotent, and stops claiming to have created anything', async () => {
    // A second run reporting "created" would be a lie a script could act on.
    const root = await workspace();
    await dbUp(root);
    const second = await dbUp(root);
    expect(second.created).toBe(false);
    expect(formatDbUp(second)).toContain('is up');
  }, 180_000);
});

describe('db:down', () => {
  it('reports honestly when nothing was held', async () => {
    const root = await workspace();
    const result = await dbDown(root);
    expect(result.released).toBe(false);
    expect(formatDbDown(result)).toContain('nothing to release');
  }, 90_000);

  it('refuses to bring down a server it does not manage', async () => {
    // ADR-0068: we do not provision the server, the user does. A tool that stops
    // a database it did not start is one nobody can safely run twice — and the
    // server predates this workspace and will outlive it.
    const root = await workspace();
    const configPath = resolveWorkspaceLayout(root).configPath;
    const raw = await fs.readFile(configPath, 'utf8');
    // Rewritten through the YAML parser rather than by regex: a substitution
    // that produced invalid YAML would fail this test for a reason that has
    // nothing to do with what it is checking.
    const parsed = YAML.parse(raw) as { database?: Record<string, unknown> };
    parsed.database = { mode: 'connected', url: 'postgres://user:pw@localhost:5432/x' };
    await fs.writeFile(configPath, YAML.stringify(parsed), 'utf8');

    const result = await dbDown(root);
    expect(result.mode).toBe('connected');
    expect(result.released).toBe(false);
    expect(result.because).toMatch(/not ours to do/);
  }, 90_000);
});

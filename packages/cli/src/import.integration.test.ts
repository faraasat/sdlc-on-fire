import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { existingImports, runImport, targetPathFor } from './import.js';

/**
 * Teardown retries, because Windows keeps a file locked while anything holds it.
 *
 * A child process that has just exited can still own its handles for a moment,
 * and removing the directory then fails with EBUSY — which Vitest reports as a
 * failed suite even though every assertion in it passed. Retrying is the
 * documented remedy, and is a no-op on platforms without the problem.
 */
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

/**
 * `sdlc import` (P2-IMP-07), against a real OpenSpec tree in a real workspace.
 *
 * The tests that matter are about the second run. A migration is not "import
 * once and hope" — it is import, find one source file wrong, fix it, import
 * again. Everything here exists to hold that loop safe.
 */

let root: string;
const dirs: string[] = [];

const SPEC = `### Requirement: User Authentication
The system SHALL issue a JWT token upon successful login.

### Requirement: Session Expiration
The system MUST expire sessions after 30 minutes.
`;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'import-')));
  dirs.push(root);
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'openspec', 'specs', 'auth'), { recursive: true });
  await fs.writeFile(path.join(root, 'openspec', 'specs', 'auth', 'spec.md'), SPEC, 'utf8');
}, 120_000);

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true, ...RM_RETRY })),
  );
});

describe('dry run', () => {
  it('reports the plan and writes absolutely nothing', async () => {
    const report = await runImport(root, { dryRun: true });
    expect(report.plan.created).toBe(2);
    expect(report.dryRun).toBe(true);

    // Not one file, not the originals copy. A dry run that touches disk is not
    // a dry run.
    const kanban = await fs.readdir(path.join(root, 'kanban')).catch(() => []);
    expect(kanban).not.toContain('_imported');
    expect(await fs.readdir(path.join(root, '.sdlcof')).catch(() => [])).not.toContain('imported');
  }, 120_000);

  it('previews exactly what the real run then does', async () => {
    const preview = await runImport(root, { dryRun: true });
    const real = await runImport(root);
    // Same computation, not a prediction of it — which is the only way a preview
    // cannot drift from the thing it previews.
    expect(real.plan.created).toBe(preview.plan.created);
    expect(real.plan.order.map((entry) => entry.key)).toEqual(
      preview.plan.order.map((entry) => entry.key),
    );
  }, 120_000);
});

describe('a real import', () => {
  it('writes one file per requirement and commits', async () => {
    const report = await runImport(root);
    expect(report.committed).toBe(true);

    const dir = path.join(root, 'docs', '_imported', 'spec');
    const written = await fs.readdir(dir);
    expect(written).toHaveLength(2);

    // Filenames are content-hashes, so read both rather than assuming an order.
    const bodies = await Promise.all(
      written.map((name) => fs.readFile(path.join(dir, name), 'utf8')),
    );
    expect(bodies.every((body) => body.includes('external_ref'))).toBe(true);
    expect(bodies.join('\n')).toContain('SHALL issue a JWT');
    expect(bodies.join('\n')).toContain('MUST expire sessions');
  }, 120_000);

  it('copies the originals rather than moving or mutating them', async () => {
    const report = await runImport(root);
    expect(report.originalsCopiedTo).toBeDefined();

    // The source survives untouched. A migration that consumes its own source
    // leaves the user no way back and nothing to compare against.
    expect(await fs.readFile(path.join(root, 'openspec', 'specs', 'auth', 'spec.md'), 'utf8')).toBe(
      SPEC,
    );
    const copied = path.join(
      report.originalsCopiedTo as string,
      'openspec',
      'specs',
      'auth',
      'spec.md',
    );
    expect(await fs.readFile(copied, 'utf8')).toBe(SPEC);
  }, 120_000);

  it('records external_ref in the written file, where db:rebuild cannot erase it', async () => {
    await runImport(root);
    const found = await existingImports(root);
    // The idempotency key has to survive a rebuild, or the next import
    // duplicates the entire migration.
    expect(found).toHaveLength(2);
    expect(found[0]?.key.startsWith('openspec:')).toBe(true);
  }, 120_000);
});

describe('running it twice — the whole point', () => {
  it('does nothing on an unchanged second run', async () => {
    await runImport(root);
    const second = await runImport(root);

    expect(second.plan.created).toBe(0);
    expect(second.plan.unchanged).toBe(2);
  }, 120_000);

  it('touches only what changed in the source', async () => {
    await runImport(root);
    await fs.writeFile(
      path.join(root, 'openspec', 'specs', 'auth', 'spec.md'),
      SPEC.replace('30 minutes', '15 minutes'),
      'utf8',
    );

    const second = await runImport(root);
    // One updated, one left alone. Without this a re-run rewrites four hundred
    // files with a new timestamp and the diff is unreadable.
    expect(second.plan.updated).toBe(1);
    expect(second.plan.unchanged).toBe(1);
    expect(second.plan.created).toBe(0);
  }, 120_000);
});

describe('refusals', () => {
  it('refuses when nothing was detected, and says how to look', async () => {
    const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bare-')));
    dirs.push(bare);
    await init(bare, { database: 'skip' });
    await expect(runImport(bare)).rejects.toThrow(/nothing to import/);
  }, 120_000);

  it('refuses to overwrite a file a human wrote', async () => {
    const preview = await runImport(root, { dryRun: true });
    const target = preview.plan.order[0];
    expect(target).toBeDefined();

    // Put a human-authored file exactly where the import wants to land — asked
    // for with `targetPathFor` rather than re-derived here. This test used to
    // rebuild the naming rule itself, which is part of why the identifier
    // collision P8-MIGRATE-01 found stayed invisible: a test that reimplements
    // production logic agrees with it even when both are wrong.
    const dir = path.join(root, 'docs', '_imported', 'spec');
    await fs.mkdir(dir, { recursive: true });
    for (const entry of preview.plan.order) {
      const target = targetPathFor(root, entry.node);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '# mine\n', 'utf8');
    }

    // Silently overwriting someone's work is the worst possible default.
    await expect(runImport(root)).rejects.toThrow(/already exist/);
    expect(await fs.readFile(path.join(dir, await firstFile(dir)), 'utf8')).toBe('# mine\n');
  }, 120_000);

  it('names a specific tool that is not present rather than importing another', async () => {
    await expect(runImport(root, { from: 'bmad' })).rejects.toThrow(/no bmad source/);
  }, 120_000);
});

async function firstFile(dir: string): Promise<string> {
  const entries = await fs.readdir(dir);
  return entries[0] as string;
}

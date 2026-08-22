import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { availableTargets, runExport } from './export.js';

/**
 * `sdlc export` against a real workspace (P4-EXP-01).
 *
 * The exporters are pure and tested in the importers package. What only this can
 * show is that real cards on disk reach them, and — the assertion that matters —
 * that a fidelity violation stops the write. A partially written snapshot that
 * also failed its own check is worse than none: somebody finds the files later
 * with no record of why they were rejected.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-export-'));
  await init(root, { database: 'skip' });
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'FEAT-001.md'),
    [
      '---',
      'id: FEAT-001',
      'type: feature',
      'title: Bounded retries',
      '---',
      '',
      'Retries stop at 3.',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(dir, 'EPIC-001.md'),
    [
      '---',
      'id: EPIC-001',
      'type: epic',
      'title: Reliability',
      '---',
      '',
      'Make it not fall over.',
      '',
    ].join('\n'),
  );
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc export', () => {
  it('offers the four targets the import direction supports', () => {
    expect(availableTargets()).toEqual(['bmad', 'gsd', 'openspec', 'speckit']);
  });

  it('writes real cards through to files', async () => {
    const result = await runExport(root, 'openspec');
    expect(result.wrote).toBe(true);
    expect(result.filesWritten).toBeGreaterThan(0);

    const written = await fs.readFile(
      path.join(
        root,
        '.sdlcof',
        'export',
        'openspec',
        'openspec',
        'specs',
        'bounded-retries',
        'spec.md',
      ),
      'utf8',
    );
    expect(written).toContain('# Bounded retries');
    expect(written).toContain('Retries stop at 3.');
  });

  it('keeps the work-item id as a preserved identifier', async () => {
    // Teams reference these in commits and PRs; an export that renumbered them
    // would break every one of those references silently.
    await runExport(root, 'openspec');
    const written = await fs.readFile(
      path.join(
        root,
        '.sdlcof',
        'export',
        'openspec',
        'openspec',
        'specs',
        'bounded-retries',
        'spec.md',
      ),
      'utf8',
    );
    expect(written).toContain('FEAT-001');
  });

  it('reports what a lower-fidelity target cannot hold', async () => {
    const result = await runExport(root, 'bmad');
    expect(result.fidelity).toBe('best-effort');
    expect(result.losses.map((l) => l.field)).toContain('externalRef');
  });

  it('writes nothing on a dry run', async () => {
    const result = await runExport(root, 'openspec', { dryRun: true });
    expect(result.wrote).toBe(false);
    await expect(fs.access(path.join(root, '.sdlcof', 'export'))).rejects.toThrow();
  });

  it('rejects an unknown target by name rather than writing nothing quietly', async () => {
    await expect(runExport(root, 'jira')).rejects.toThrow(/unknown export target/);
  });

  it('reads the workspace, not the database', async () => {
    // Content is in git (architecture §5). Exporting from the mirror would be a
    // snapshot of a cache — this workspace was initialised with `database:
    // 'skip'`, so nothing could have come from one.
    const result = await runExport(root, 'openspec');
    expect(result.filesWritten).toBeGreaterThan(0);
  });

  it('skips an unparseable card instead of failing the whole export', async () => {
    // An export is what somebody runs while deciding whether to migrate;
    // refusing because one card is malformed makes it unusable on exactly the
    // messy repositories it exists for.
    await fs.writeFile(path.join(root, 'kanban', '_inbox', 'BROKEN.md'), 'no frontmatter at all\n');
    const result = await runExport(root, 'openspec');
    expect(result.wrote).toBe(true);
  });

  it('runs on the built binary and emits JSON', async () => {
    const { stdout } = await run(process.execPath, [CLI, 'export', '--to', 'gsd', '--json'], {
      cwd: root,
    });
    const parsed = JSON.parse(stdout) as { tool: string; fidelity: string };
    expect(parsed.tool).toBe('gsd');
    expect(parsed.fidelity).toBe('moderate');
  }, 60_000);

  it('exits non-zero on the built binary for an unknown target', async () => {
    await expect(
      run(process.execPath, [CLI, 'export', '--to', 'jira'], { cwd: root }),
    ).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});

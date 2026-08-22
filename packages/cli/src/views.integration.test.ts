import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from './commands.js';
import { listViews, readViews } from './views.js';

/**
 * `sdlc views` against a real workspace (P4-COLLAB-03).
 *
 * The unit tests prove the parsing. What only this can show is that a file an
 * author put in `docs/views/` reaches the command — the path resolution, the
 * YAML decode and the directory walk — which is the seam where every defect in
 * this project has actually lived.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-views-'));
  await init(root, { database: 'skip' });
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

async function writeView(name: string, body: string): Promise<void> {
  const dir = path.join(root, 'docs', 'views');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), body);
}

describe('sdlc views', () => {
  it('says there are none rather than failing on a fresh workspace', async () => {
    // `init` does not scaffold a views directory. Absent must read as empty,
    // not as an error — a missing optional folder is not a broken project.
    const result = await readViews(root);
    expect(result.views).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('loads a view an author put on disk', async () => {
    await writeView(
      'sec-blockers.yaml',
      [
        'name: Security blockers',
        'mode: table',
        'role: security',
        'filter:',
        '  blockedOnly: true',
      ].join('\n'),
    );
    const result = await readViews(root);
    expect(result.ok).toBe(true);
    expect(result.views).toHaveLength(1);
    expect(result.views[0]?.slug).toBe('sec-blockers');
    expect(result.views[0]?.filter.blockedOnly).toBe(true);
  });

  it('scopes by role through the real directory', async () => {
    await writeView('shared.yaml', 'name: Shared');
    await writeView('qa-only.yaml', ['name: QA only', 'role: qa'].join('\n'));

    expect((await listViews(root, 'qa')).views.map((v) => v.slug)).toEqual(['qa-only', 'shared']);
    expect((await listViews(root, 'security')).views.map((v) => v.slug)).toEqual(['shared']);
  });

  it('shows every view when no role is asked for', async () => {
    // The bug a test caught: "no --role given" and "a person with no role" are
    // different questions, and answering the first with the second hides every
    // role-scoped view from anyone who did not pass a flag.
    await writeView('shared.yaml', 'name: Shared');
    await writeView('qa-only.yaml', ['name: QA only', 'role: qa'].join('\n'));

    expect((await listViews(root)).views.map((v) => v.slug)).toEqual(['qa-only', 'shared']);
    expect((await listViews(root, null)).views.map((v) => v.slug)).toEqual(['shared']);
  });

  it('reports a YAML syntax error as a problem, not a crash', async () => {
    await writeView('broken.yaml', 'name: [unclosed');
    const result = await readViews(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.field).toBe('(yaml)');
  });

  it('keeps the good views when one file is broken', async () => {
    // Refusing to show any view because one file has a typo helps nobody. The
    // opposite of the gate rule, and deliberately so — a broken view costs a
    // menu entry, a broken gate policy costs a check.
    await writeView('fine.yaml', 'name: Fine');
    await writeView('broken.yaml', 'name: [unclosed');
    const result = await readViews(root);
    expect(result.views.map((v) => v.slug)).toEqual(['fine']);
    expect(result.ok).toBe(false);
  });

  it('refuses two files claiming one slug rather than letting order decide', async () => {
    await writeView('dupe.yaml', 'name: One');
    await writeView('dupe.yml', 'name: Two');
    const result = await readViews(root);
    expect(result.views).toHaveLength(1);
    expect(result.problems.some((p) => p.because.includes('duplicate slug'))).toBe(true);
  });

  it('ignores non-YAML files in the directory', async () => {
    await writeView('notes.md', '# not a view');
    await writeView('real.yaml', 'name: Real');
    const result = await readViews(root);
    expect(result.views.map((v) => v.slug)).toEqual(['real']);
    expect(result.ok).toBe(true);
  });

  it('runs on the built binary and emits JSON', async () => {
    await writeView('sec.yaml', ['name: Sec', 'role: security'].join('\n'));
    const { stdout } = await run(process.execPath, [CLI, 'views', '--json'], { cwd: root });
    const parsed = JSON.parse(stdout) as { views: { slug: string }[] };
    expect(parsed.views.map((v) => v.slug)).toEqual(['sec']);
  }, 60_000);

  it('exits non-zero on the built binary when a file failed to load', async () => {
    await writeView('broken.yaml', 'name: [unclosed');
    await expect(run(process.execPath, [CLI, 'views'], { cwd: root })).rejects.toMatchObject({
      code: 1,
    });
  }, 60_000);

  it('rejects an unknown --role instead of listing everything', async () => {
    // A typo'd role that returned every view reads as "this role sees them all".
    await writeView('sec.yaml', ['name: Sec', 'role: security'].join('\n'));
    await expect(
      run(process.execPath, [CLI, 'views', '--role', 'devops'], { cwd: root }),
    ).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});

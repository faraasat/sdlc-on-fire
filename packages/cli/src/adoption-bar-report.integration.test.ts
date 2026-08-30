import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applySchema } from '@sdlc-on-fire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWorkspaceDatabase } from './commands.js';

/**
 * The adoption bar end to end (P8-BAR-01/02/03).
 *
 * Every piece has its own tests. What none of them prove is that the pieces
 * compose — that a block recorded by one command, judged by a second and a
 * config weakened in a third all arrive in the same report. That is exactly the
 * gap the `runs` table sat in for a whole phase: schema, route, UI, and no
 * writer, with every individual test green.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;
let firstBlock = 0;
let secondBlock = 0;

async function sdlc(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run('node', [CLI, '-C', root, ...args], { cwd: root });
    return { stdout, code: 0 };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (error.stdout ?? '') + (error.stderr ?? ''), code: error.code ?? 1 };
  }
}

interface BarJson {
  valuableRate: { value: number | null; because: string };
  nuisanceRate: { value: number | null };
  blocksToFirstValuable: { value: number | null };
  downgradeRate: { value: number | null };
  untagged: number;
  met: boolean | null;
  because: string;
}

async function bar(): Promise<BarJson> {
  const result = await sdlc('metrics', 'adoption', '--json');
  return JSON.parse(result.stdout) as BarJson;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-bar-e2e-'));
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Ada Lovelace'], { cwd: root });
  await run('node', [CLI, '-C', root, 'init'], { cwd: root });

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('FEAT-901','feature','Composed','In Progress','implement','kanban/FEAT-901.md','abc')
       ON CONFLICT DO NOTHING;`,
    );
    const a = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result, created_at)
       VALUES ('FEAT-901','verify','fail', now() - interval '2 hours') RETURNING id;`,
    );
    firstBlock = Number(a[0]?.id);
    const b = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result, created_at)
       VALUES ('FEAT-901','review','fail', now() - interval '1 hour') RETURNING id;`,
    );
    secondBlock = Number(b[0]?.id);
  } finally {
    await db.close();
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc metrics adoption', () => {
  it('reports unmeasured — not zero — when blocks exist but nobody judged them', async () => {
    const report = await bar();
    expect(report.met).toBeNull();
    expect(report.valuableRate.value).toBeNull();
    expect(report.untagged).toBe(2);
    expect(report.because).toContain('unmeasured');
  }, 120_000);

  it('exits zero while unmeasured, so an unused install is not a failing check', async () => {
    const result = await sdlc('metrics', 'adoption');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('not available');
  }, 120_000);

  it('turns a tag into a measured bar', async () => {
    await sdlc('gates', 'tag', String(secondBlock), 'valuable', '--why', 'caught a real one');
    const report = await bar();
    expect(report.met).toBe(true);
    expect(report.valuableRate.value).toBe(1);
    // The second block chronologically, so two blocks were hit before value
    // arrived — the number ADR-0063's "within their first few sessions" asks for.
    expect(report.blocksToFirstValuable.value).toBe(2);
    expect(report.untagged).toBe(1);
  }, 120_000);

  it('a nuisance tag moves the friction counter without unsetting the valuable one', async () => {
    await sdlc(
      'gates',
      'tag',
      String(firstBlock),
      'nuisance',
      '--why',
      'fired on a lockfile churn',
    );
    const report = await bar();
    expect(report.nuisanceRate.value).toBe(0.5);
    expect(report.valuableRate.value).toBe(0.5);
    // One each: nuisance does not exceed valuable, so the bar still holds.
    expect(report.met).toBe(true);
  }, 120_000);

  it('the baseline config reading is not counted as a change', async () => {
    const first = await sdlc('config:snapshot', '--json');
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ recorded: true, first: true });

    const report = await bar();
    // Every new workspace would otherwise report a config event on day one.
    expect(report.downgradeRate.value).toBeNull();
  }, 120_000);

  it('a preset downgrade is observed, and it fails the bar on its own', async () => {
    const configPath = path.join(root, '.sdlcof', 'config.yaml');
    const before = await fs.readFile(configPath, 'utf8');
    await fs.writeFile(
      configPath,
      before.includes('preset:')
        ? before.replace(/preset:.*/, 'preset: lite')
        : `${before}\npreset: lite\n`,
      'utf8',
    );

    const snapshot = await sdlc('config:snapshot', '--json');
    // Exit 2, not 1: a downgrade is the user's call, not an error — but it is
    // the abandonment leading indicator, so it is noticeable to a hook.
    expect(snapshot.code).toBe(2);
    const parsed = JSON.parse(snapshot.stdout) as {
      downgrade: boolean;
      drift: { direction: string };
    };
    expect(parsed.downgrade).toBe(true);
    expect(parsed.drift.direction).toBe('weakened');

    const report = await bar();
    expect(report.met).toBe(false);
    expect(report.because).toContain('downgrade');
    expect(report.downgradeRate.value).toBe(1);
  }, 120_000);

  it('a measured failure exits non-zero, unlike an unmeasured one', async () => {
    const result = await sdlc('metrics', 'adoption');
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('NOT MET');
  }, 120_000);

  it('records nothing on a second reading with no edit in between', async () => {
    const again = await sdlc('config:snapshot', '--json');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ recorded: false });
  }, 120_000);
});

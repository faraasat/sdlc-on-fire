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
 * `sdlc gates tag` against the **built binary** (P8-BAR-01, ADR-0063).
 *
 * The core unit tests prove the admission rules and the db suite proves the
 * triggers. Neither proves a person can reach any of it, and that is where the
 * defects in this repository have actually lived — a doc-visibility check
 * nothing called, a cursor store with full coverage and no caller, and the
 * `runs` table that had a schema, an API route and no writer.
 *
 * This metric is made *entirely* of data that does not exist unless somebody
 * records it, so an unreachable command is the same as no feature.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;
let failedGate = 0;
let passedGate = 0;

async function sdlc(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run('node', [CLI, '-C', root, ...args], { cwd: root });
    return { stdout, code: 0 };
  } catch (cause) {
    const error = cause as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (error.stdout ?? '') + (error.stderr ?? ''), code: error.code ?? 1 };
  }
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-bar-cli-'));
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Ada Lovelace'], { cwd: root });
  await run('node', [CLI, '-C', root, 'init'], { cwd: root });

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('FEAT-900','feature','Tagged','In Progress','implement','kanban/FEAT-900.md','abc')
       ON CONFLICT DO NOTHING;`,
    );
    const failed = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('FEAT-900','verify','fail') RETURNING id;`,
    );
    failedGate = Number(failed[0]?.id);
    const passed = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('FEAT-900','review','pass') RETURNING id;`,
    );
    passedGate = Number(passed[0]?.id);
  } finally {
    await db.close();
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc gates tag', () => {
  it('is reachable from the built binary', async () => {
    const help = await sdlc('gates', '--help');
    expect(help.stdout).toContain('tag');
  }, 120_000);

  it('records a valuable block against the git identity, with no role needed', async () => {
    // Deliberately no `sdlc access grant` in the setup. Requiring a role would
    // restrict the measure to approvers, whose view of gate friction is the
    // least representative one there is.
    const result = await sdlc(
      'gates',
      'tag',
      String(failedGate),
      'valuable',
      '--why',
      'caught a missing migration',
      '--json',
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { recorded: boolean; actor: string };
    expect(parsed.recorded).toBe(true);
    expect(parsed.actor).toBe('Ada Lovelace');
  }, 120_000);

  it('reports what a re-tag supersedes rather than silently replacing it', async () => {
    const result = await sdlc(
      'gates',
      'tag',
      String(failedGate),
      'nuisance',
      '--why',
      'on reflection the rebase made it fire twice',
      '--json',
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      recorded: boolean;
      supersedes?: { outcome: string };
    };
    expect(parsed.recorded).toBe(true);
    expect(parsed.supersedes?.outcome).toBe('valuable');
  }, 120_000);

  it('exits non-zero when the tag is refused — an uncaptured datum is a failure', async () => {
    const result = await sdlc('gates', 'tag', String(passedGate), 'valuable', '--json');
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { recorded: boolean; refusal: string };
    expect(parsed).toMatchObject({ recorded: false, refusal: 'gate-not-a-block' });
  }, 120_000);

  it('names the gate it could not find rather than reporting an empty success', async () => {
    const result = await sdlc('gates', 'tag', '424242', 'valuable', '--json');
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { refusal: string; because: string };
    expect(parsed.refusal).toBe('gate-not-found');
    expect(parsed.because).toContain('424242');
  }, 120_000);

  it('refuses an outcome outside the vocabulary and says what was allowed', async () => {
    const result = await sdlc('gates', 'tag', String(failedGate), 'neutral', '--json');
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { refusal: string; because: string };
    expect(parsed.refusal).toBe('unknown-outcome');
    expect(parsed.because).toContain('nuisance');
  }, 120_000);

  it('writes an audit row, so the tag has a provenance like every other decision', async () => {
    const { db } = await openWorkspaceDatabase(root);
    try {
      const rows = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log WHERE action = 'GATE_OUTCOME_TAGGED';`,
      );
      expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(2);
    } finally {
      await db.close();
    }
  }, 120_000);
});

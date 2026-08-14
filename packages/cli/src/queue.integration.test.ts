import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, claimWorkItem } from './commands.js';
import { queueFor } from './queue.js';

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
 * `sdlc queue` — the dependency graph, finally readable (P1-SCHED-02).
 *
 * `resolveWaves` shipped with the task spec, fully tested, and had no caller
 * anywhere. `blocked_by` was on the cards and in the frontmatter allowlist and
 * nothing outside that one pure function ever read it. So the graph existed, the
 * scheduler existed, and no command would tell you what to do next.
 */

const run = promisify(execFile);
let root: string;

interface CardFields {
  readonly risk?: string;
  readonly blockedBy?: readonly string[];
  readonly ownership?: readonly string[];
  readonly stage?: string;
}

async function writeCard(id: string, fields: CardFields = {}): Promise<void> {
  const dir = path.join(root, 'kanban', '_inbox');
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    '---',
    '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
    `id: ${id}`,
    'kind: task',
    `title: Task ${id}`,
    'status: In Progress',
    `lifecycle_state: ${fields.stage ?? 'implement'}`,
    'work_type: task',
    'preset: standard',
    `risk_level: ${fields.risk ?? 'low'}`,
    'verify: node test.js',
    'done:',
    '  - tests pass',
    ...(fields.blockedBy === undefined
      ? []
      : ['blocked_by:', ...fields.blockedBy.map((dep) => `  - ${dep}`)]),
    ...(fields.ownership === undefined
      ? []
      : ['file_ownership:', ...fields.ownership.map((glob) => `  - ${glob}`)]),
    'created_at: 2026-08-10T00:00:00.000Z',
    'updated_at: 2026-08-10T00:00:00.000Z',
    '---',
    '',
    'body',
    '',
  ];
  await fs.writeFile(path.join(dir, `${id}.md`), lines.join('\n'), 'utf8');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'queue-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'T'], { cwd: root });
  await init(root, { database: 'skip' });
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('ordering the open work', () => {
  it('puts a blocker before what it blocks', async () => {
    await writeCard('TASK-001');
    await writeCard('TASK-002', { blockedBy: ['TASK-001'] });

    const result = await queueFor(root);
    expect(result.waves[0]?.items.map((item) => item.id)).toEqual(['TASK-001']);
    expect(result.waves[1]?.items.map((item) => item.id)).toEqual(['TASK-002']);
  }, 180_000);

  it('runs higher-risk work first among things that can run now', async () => {
    // Risk becomes the ordering weight rather than a second `priority` field: an
    // author already states risk, and two answers to one question drift apart.
    await writeCard('TASK-003', { risk: 'low', ownership: ['a/**'] });
    await writeCard('TASK-004', { risk: 'high', ownership: ['b/**'] });

    const result = await queueFor(root);
    expect(result.waves[0]?.items[0]?.id).toBe('TASK-004');
  }, 180_000);

  it('never lets priority jump a dependency', async () => {
    // Priority answers "which of the things that can run now goes first";
    // a dependency answers "can this run at all". Scheduling high-risk work
    // against code that does not exist yet is not a prioritisation.
    await writeCard('TASK-005', { risk: 'low' });
    await writeCard('TASK-006', { risk: 'high', blockedBy: ['TASK-005'] });

    const result = await queueFor(root);
    expect(result.waves[0]?.items.map((item) => item.id)).toEqual(['TASK-005']);
  }, 180_000);

  it('splits a wave when two items own overlapping files', async () => {
    await writeCard('TASK-007', { ownership: ['src/**'] });
    await writeCard('TASK-008', { ownership: ['src/parser.ts'] });

    const result = await queueFor(root);
    expect(result.waves[0]?.items).toHaveLength(1);
    expect(result.waves[1]?.items).toHaveLength(1);
  }, 180_000);
});

describe('what the plan leaves out', () => {
  it('excludes finished work rather than showing it as ready', async () => {
    // A plan whose first wave is mostly already-done items is a plan nobody
    // reads twice.
    await writeCard('TASK-009', { stage: 'done' });
    await writeCard('TASK-010');

    const result = await queueFor(root);
    expect(result.completed).toEqual(['TASK-009']);
    expect(result.waves[0]?.items.map((item) => item.id)).toEqual(['TASK-010']);
  }, 180_000);

  it('treats a dependency on finished work as satisfied', async () => {
    // Keeping it would leave the graph permanently blocked on completed work.
    await writeCard('TASK-011', { stage: 'done' });
    await writeCard('TASK-012', { blockedBy: ['TASK-011'] });

    const result = await queueFor(root);
    expect(result.waves[0]?.items.map((item) => item.id)).toEqual(['TASK-012']);
  }, 180_000);
});

describe('what it refuses to smooth over', () => {
  it('reports a cycle instead of dropping an edge to make one', async () => {
    // Silently dropping an edge would produce a plan that schedules work against
    // code that does not exist — and the plan would look fine.
    await writeCard('TASK-013', { blockedBy: ['TASK-014'] });
    await writeCard('TASK-014', { blockedBy: ['TASK-013'] });

    const result = await queueFor(root);
    expect(result.waves).toEqual([]);
    expect([...(result.cycle ?? [])].sort()).toEqual(['TASK-013', 'TASK-014']);
  }, 180_000);
});

describe('who already holds what', () => {
  it('marks an item somebody has claimed', async () => {
    await writeCard('TASK-015');
    await claimWorkItem(root, 'TASK-015', 'alice');

    const result = await queueFor(root);
    expect(result.waves[0]?.items[0]?.claimedBy).toBe('alice');
  }, 180_000);
});

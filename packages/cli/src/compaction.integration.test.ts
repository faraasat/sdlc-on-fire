import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { init, openWorkspaceDatabase } from './commands.js';
import { compactRun, compactionsFor, formatCompact, recordTurn } from './horizon.js';

/**
 * Bounded compaction against real PGlite (P7-HORIZON-02).
 *
 * The claim that matters is not that context got smaller — it is that what was
 * dropped is still on record. A trim that leaves no trace is forgetting, and
 * the output it produces is output nobody can account for.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;
let root: string;

async function seedRun(runId: string): Promise<void> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await port.upsertWorkItem({
      id: 'TASK-001',
      type: 'task',
      title: 'Long run',
      status: 'In Progress',
      lifecycleState: 'implement',
      filePath: 'kanban/_inbox/TASK-001.md',
      contentHash: 'a'.repeat(64),
    });
    await port.startRun({
      id: runId,
      workItemId: 'TASK-001',
      skillId: 'implement',
      startedAt: '2026-08-30T00:00:00.000Z',
    });
  } finally {
    await db.close();
  }
}

async function setBudget(tokens: number, retainRecent?: number): Promise<void> {
  const configPath = path.join(root, '.sdlcof', 'config.yaml');
  const config = await fs.readFile(configPath, 'utf8');
  // Rewritten, not appended: a second append produces a duplicate `context:`
  // key, which is a YAML error rather than an override.
  const withoutContext = config.replace(/\ncontext:\n(?: {2}.*\n)*/g, '\n');
  await fs.writeFile(
    configPath,
    [
      withoutContext.trimEnd(),
      'context:',
      `  run_budget_tokens: ${String(tokens)}`,
      ...(retainRecent === undefined ? [] : [`  retain_recent_turns: ${String(retainRecent)}`]),
      '',
    ].join('\n'),
    'utf8',
  );
}

async function longRun(turnCount: number, each = 1000): Promise<void> {
  for (let turn = 1; turn <= turnCount; turn += 1) {
    await recordTurn(root, { runId: 'run-1', turn, inputTokens: each, outputTokens: 0 });
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'compact-')));
  await init(root, { database: 'skip' });
  await seedRun('run-1');
}, 180_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('the declared budget', () => {
  it('never fires without one', async () => {
    // The default is undeclared, and undeclared means no compaction. A ceiling
    // picked by us would silently discard context on somebody else's project.
    await longRun(50);
    const result = await compactRun(root, 'run-1', { apply: true });
    expect(result.plan.fired).toBe(false);
    expect(result.plan.refusal).toBe('no-budget');
  }, 180_000);

  it('fires against a configured one', async () => {
    await setBudget(10_000);
    await longRun(20);
    const result = await compactRun(root, 'run-1', { apply: true });
    expect(result.plan.fired).toBe(true);
    expect(result.plan.budgetTokens).toBe(10_000);
  }, 180_000);

  it('accepts an override on the command', async () => {
    await longRun(20);
    const result = await compactRun(root, 'run-1', { apply: true, budgetTokens: 10_000 });
    expect(result.plan.fired).toBe(true);
  }, 180_000);
});

describe('recording what was dropped', () => {
  it('writes both the dropped and the retained turns', async () => {
    await setBudget(10_000);
    await longRun(20);
    await compactRun(root, 'run-1', { apply: true, firedAt: '2026-08-30T01:00:00.000Z' });

    const [record] = await compactionsFor(root, 'run-1');
    expect(record).toBeDefined();
    expect(record?.droppedTurns.length).toBeGreaterThan(0);
    // "What was kept" is not derivable from "what was dropped" once the run has
    // moved on, so both are stored.
    expect(record?.retainedTurns).toContain(1);
    expect(record?.retainedTurns).toContain(20);
    expect(record?.freedTokens).toBeGreaterThan(0);
  }, 180_000);

  it('stores the budget it fired against, not the one in force later', async () => {
    await setBudget(10_000);
    await longRun(20);
    await compactRun(root, 'run-1', { apply: true });
    await setBudget(999_999);

    const [record] = await compactionsFor(root, 'run-1');
    // Otherwise every past compaction becomes unexplainable the day the budget
    // changes.
    expect(record?.budgetTokens).toBe(10_000);
  }, 180_000);

  it('writes nothing without --apply', async () => {
    await setBudget(10_000);
    await longRun(20);
    const result = await compactRun(root, 'run-1');
    expect(result.plan.fired).toBe(true);
    expect(result.recorded).toBe(false);
    expect(await compactionsFor(root, 'run-1')).toEqual([]);
    expect(formatCompact(result)).toContain('dry run');
  }, 180_000);

  it('writes nothing when the plan did not fire', async () => {
    await setBudget(1_000_000);
    await longRun(5);
    const result = await compactRun(root, 'run-1', { apply: true });
    expect(result.recorded).toBe(false);
    expect(await compactionsFor(root, 'run-1')).toEqual([]);
  }, 180_000);

  it('accumulates across compactions rather than replacing the last', async () => {
    await setBudget(10_000);
    await longRun(20);
    await compactRun(root, 'run-1', { apply: true, firedAt: '2026-08-30T01:00:00.000Z' });
    await compactRun(root, 'run-1', { apply: true, firedAt: '2026-08-30T02:00:00.000Z' });
    expect(await compactionsFor(root, 'run-1')).toHaveLength(2);
  }, 180_000);
});

describe('a config that cannot be read', () => {
  it('refuses rather than silently disabling compaction', async () => {
    // Absent is fine — no budget means no compaction. *Broken* is not: the run
    // would grow past a ceiling somebody declared and nothing would say why.
    await setBudget(10_000);
    await longRun(20);
    // Broken *after* the turns are recorded, so the failure under test is the
    // one `compact` hits rather than one the setup hit first.
    const configPath = path.join(root, '.sdlcof', 'config.yaml');
    await fs.appendFile(configPath, '\ncontext:\n  run_budget_tokens: 1\n', 'utf8');
    await expect(compactRun(root, 'run-1', { apply: true })).rejects.toThrow(/not valid YAML/);
  }, 180_000);
});

describe('what survives', () => {
  it('keeps the first turn and the recent ones', async () => {
    await setBudget(5_000);
    await longRun(20);
    const result = await compactRun(root, 'run-1', { apply: true });
    expect(result.plan.retainedTurns).toContain(1);
    for (const recent of [18, 19, 20]) {
      expect(result.plan.retainedTurns).toContain(recent);
    }
  }, 180_000);

  it('honours a configured retention window', async () => {
    await setBudget(5_000, 8);
    await longRun(20);
    const result = await compactRun(root, 'run-1', { apply: true });
    for (let recent = 13; recent <= 20; recent += 1) {
      expect(result.plan.retainedTurns).toContain(recent);
    }
  }, 180_000);
});

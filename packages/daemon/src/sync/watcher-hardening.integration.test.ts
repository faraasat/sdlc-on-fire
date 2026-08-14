import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { SyncEngine, type SyncOutcome } from './sync-engine.js';

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
 * Watcher hardening (P0-SYNC-03).
 *
 * Startup reconciliation and `awaitWriteFinish` shipped with P0-SYNC-01. What
 * these cover is the third piece: batching events during a git operation, so a
 * checkout that rewrites hundreds of files does not fire hundreds of syncs
 * against a tree that is still moving.
 *
 * Polling is forced throughout — these assert on our batching logic, not on how
 * promptly the operating system feels like delivering FSEvents.
 */

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let root: string;
let engine: SyncEngine;
const seen: SyncOutcome[] = [];

const card = (id: string): string =>
  `---\nid: ${id}\nkind: task\ntitle: ${id}\nstatus: To Do\n` +
  `lifecycle_state: implement\nwork_type: task\npreset: standard\n---\n\nbody\n`;

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-hard-')));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });

  engine = new SyncEngine({
    workspaceRoot: root,
    store: port,
    usePolling: true,
    awaitWriteFinishMs: 50,
    onSynced: (outcome) => seen.push(outcome),
  });
  await engine.reconcile();
  await engine.start();
}, 120_000);

afterAll(async () => {
  await engine.stop().catch(() => undefined);
  await db.close();
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('suspending during a git operation', () => {
  it('defers writes made while suspended instead of syncing each one', async () => {
    engine.suspend();
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(
        path.join(root, 'kanban', '_inbox', `TASK-${i}0.md`),
        card(`TASK-${i}0`),
        'utf8',
      );
    }
    // Give the watcher time to notice; nothing should have reached the mirror.
    await new Promise((r) => setTimeout(r, 400));
    expect(await port.stageOf('TASK-00')).toBeNull();

    // Reconcile-on-resume, because the watcher's account of a git operation is
    // exactly what cannot be trusted.
    const outcomes = await engine.resume({ reconcile: true });
    expect(outcomes.filter((o) => o.action === 'upserted').length).toBeGreaterThan(0);
    expect(await port.stageOf('TASK-00')).not.toBeNull();
  }, 60_000);

  it('collapses repeated writes to one file into a single sync', async () => {
    // A rebase can touch the same file several times; syncing each is waste.
    engine.suspend();
    const file = path.join(root, 'kanban', '_inbox', 'TASK-90.md');
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(file, card('TASK-90'), 'utf8');
      await new Promise((r) => setTimeout(r, 60));
    }
    const outcomes = await engine.resume({ reconcile: true });
    // Four writes to one file, one sync — a rebase can touch the same file
    // several times and syncing each is pure waste.
    expect(outcomes.filter((o) => o.relativePath === 'kanban/_inbox/TASK-90.md')).toHaveLength(1);
  }, 60_000);

  it('releases the suspension even when the operation throws', async () => {
    // A failed rebase that left the watcher deaf would be far worse than the
    // failed rebase itself.
    await expect(
      engine.duringGitOperation(async () => {
        await fs.writeFile(
          path.join(root, 'kanban', '_inbox', 'TASK-91.md'),
          card('TASK-91'),
          'utf8',
        );
        throw new Error('rebase failed');
      }),
    ).rejects.toThrow('rebase failed');

    // Suspension released, and the write still landed.
    expect(await port.stageOf('TASK-91')).not.toBeNull();
  }, 60_000);

  it('goes back to live syncing after resume', async () => {
    await fs.writeFile(path.join(root, 'kanban', '_inbox', 'TASK-92.md'), card('TASK-92'), 'utf8');

    // Poll for this card specifically. Waiting on the observer's length instead
    // makes the test pass on *any* file's sync, and the delivery deadline is
    // the operating system's to choose — under full-suite parallel load it is
    // not prompt. The claim under test is "a live write still lands", not
    // "it lands within N milliseconds".
    let stage = await port.stageOf('TASK-92');
    for (let i = 0; i < 150 && stage === null; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      stage = await port.stageOf('TASK-92');
    }
    expect(stage).not.toBeNull();
  }, 60_000);
});

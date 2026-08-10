import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentHash } from '@sdlc-on-fire/core';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncEngine, type SyncOutcome } from './sync-engine.js';

/**
 * Real files, real PGlite, real schema. The claim under test is "an edit on disk
 * lands in the mirror and the daemon's own write does not loop" — neither half
 * is observable against a mock.
 */

let db: ProvisionedDatabase;
let root: string;
let engine: SyncEngine;
const tempRoots: string[] = [];

async function write(relative: string, content: string): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
  return full;
}

function taskFile(id: string, title: string, stage = 'implement', status = 'In Progress'): string {
  return `---\nid: ${id}\nkind: task\ntitle: ${title}\nstatus: ${status}\nlifecycle_state: ${stage}\nwork_type: feature\npreset: standard\n---\n\nbody\n`;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-sync-'));
  tempRoots.push(root);
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  engine = new SyncEngine({ workspaceRoot: root, store: db });
}, 90_000);

afterAll(async () => {
  await engine.stop().catch(() => undefined);
  await db.close().catch(() => undefined);
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function rows(table: string, filePath: string): Promise<Record<string, unknown>[]> {
  return db.query(`SELECT * FROM ${table} WHERE file_path = $1;`, [filePath]);
}

describe('markdown to mirror', () => {
  it('upserts a work item', async () => {
    const file = await write('kanban/epics/e/TASK-001.md', taskFile('TASK-001', 'First'));
    const outcome = await engine.syncFile(file);

    expect(outcome.action).toBe('upserted');
    expect(outcome.kind).toBe('work_item');

    const [row] = await rows('work_items', 'kanban/epics/e/TASK-001.md');
    expect(row?.['id']).toBe('TASK-001');
    expect(row?.['title']).toBe('First');
    expect(row?.['lifecycle_state']).toBe('implement');
  });

  it('updates an existing row rather than duplicating it', async () => {
    const file = await write('kanban/epics/e/TASK-001.md', taskFile('TASK-001', 'Renamed'));
    await engine.syncFile(file);

    const all = await rows('work_items', 'kanban/epics/e/TASK-001.md');
    expect(all).toHaveLength(1);
    expect(all[0]?.['title']).toBe('Renamed');
  });

  it('routes non-kanban markdown to docs', async () => {
    const file = await write('docs/ARCHITECTURE.md', '---\ntitle: Arch\n---\n\nbody\n');
    const outcome = await engine.syncFile(file);

    expect(outcome.kind).toBe('doc');
    const [row] = await rows('docs', 'docs/ARCHITECTURE.md');
    expect(row?.['title']).toBe('Arch');
  });

  it('removes the row when the file is gone', async () => {
    const file = await write('kanban/epics/e/TASK-999.md', taskFile('TASK-999', 'Doomed'));
    await engine.syncFile(file);
    await fs.rm(file);

    expect((await engine.syncFile(file)).action).toBe('deleted');
    expect(await rows('work_items', 'kanban/epics/e/TASK-999.md')).toHaveLength(0);
  });

  it('refuses work-item frontmatter with no id rather than inventing one', async () => {
    const file = await write('kanban/epics/e/bad.md', '---\ntitle: no id\n---\n\nbody\n');
    await expect(engine.syncFile(file)).rejects.toThrow(/no id/);
  });
});

describe('change detection', () => {
  it('skips a file whose content has not changed', async () => {
    const file = await write('kanban/epics/e/TASK-002.md', taskFile('TASK-002', 'Stable'));
    await engine.syncFile(file);

    expect((await engine.syncFile(file)).action).toBe('skipped-unchanged');
  });

  it('re-processes a real edit', async () => {
    const file = await write('kanban/epics/e/TASK-002.md', taskFile('TASK-002', 'Edited'));
    expect((await engine.syncFile(file)).action).toBe('upserted');
  });
});

describe('write-back-loop guard', () => {
  it('skips a file the daemon recorded as its own write', async () => {
    const content = taskFile('TASK-003', 'Self');
    const file = await write('kanban/epics/e/TASK-003.md', content);
    engine.registry.record('kanban/epics/e/TASK-003.md', contentHash(content));

    expect((await engine.syncFile(file)).action).toBe('skipped-self-write');
    // And it genuinely did not reach the mirror.
    expect(await rows('work_items', 'kanban/epics/e/TASK-003.md')).toHaveLength(0);
  });

  it('processes the next event on that path normally', async () => {
    // The claim is consumed, so an external edit right after a self-write is not
    // swallowed.
    const file = path.join(root, 'kanban/epics/e/TASK-003.md');
    expect((await engine.syncFile(file)).action).toBe('upserted');
  });

  it('does not let a byte-identical external edit be mistaken for a self-write', async () => {
    // The race hash-equality alone cannot resolve: same bytes, different author.
    const content = taskFile('TASK-004', 'Twin');
    const file = await write('kanban/epics/e/TASK-004.md', content);
    await engine.syncFile(file);

    await fs.writeFile(file, content, 'utf8');
    // Unchanged content is skipped as unchanged — never as a self-write, which
    // would consume a claim that was never made.
    expect((await engine.syncFile(file)).action).toBe('skipped-unchanged');
  });
});

describe('re-embed hook', () => {
  it('fires only on a real content change', async () => {
    const seen: SyncOutcome[] = [];
    const hooked = new SyncEngine({
      workspaceRoot: root,
      store: db,
      onReEmbed: (outcome) => {
        seen.push(outcome);
      },
    });

    const file = await write('kanban/epics/e/TASK-005.md', taskFile('TASK-005', 'Hooked'));
    await hooked.syncFile(file);
    await hooked.syncFile(file); // unchanged

    expect(seen).toHaveLength(1);
    expect(seen[0]?.action).toBe('upserted');
  });
});

describe('startup reconciliation', () => {
  it('walks the managed tree and syncs what it finds', async () => {
    await write('kanban/epics/e/TASK-100.md', taskFile('TASK-100', 'Walked'));
    await write('docs/TESTING.md', '---\ntitle: Testing\n---\n\nbody\n');

    const outcomes = await engine.reconcile();
    const paths = outcomes.map((o) => o.relativePath);
    expect(paths).toContain('kanban/epics/e/TASK-100.md');
    expect(paths).toContain('docs/TESTING.md');
  });

  it('leaves nothing unprocessed on a second pass', async () => {
    // Everything is now unchanged — reconcile must be cheap, not destructive.
    const outcomes = await engine.reconcile();
    const rest = outcomes.filter((o) => o.action !== 'failed');
    expect(rest.every((o) => o.action === 'skipped-unchanged')).toBe(true);
  });

  it('reports a malformed file without abandoning the rest of the tree', async () => {
    // One bad card must not stop the other nine hundred reaching the mirror.
    const outcomes = await engine.reconcile();
    const failed = outcomes.filter((o) => o.action === 'failed');

    expect(failed.map((o) => o.relativePath)).toContain('kanban/epics/e/bad.md');
    expect(failed[0]?.error).toMatch(/no id/);
    // And the good files in the same walk still synced.
    expect(outcomes.some((o) => o.relativePath === 'kanban/epics/e/TASK-100.md')).toBe(true);
  });
});

describe('watching', () => {
  it('picks up a file created after start and reports the outcome', async () => {
    // Awaits the engine's own signal rather than polling the database: a poll
    // deadline turns event-delivery latency into a flaky test, and this suite's
    // credibility is the product's core claim.
    const outcomes: SyncOutcome[] = [];
    let resolveSynced: (() => void) | undefined;
    const synced = new Promise<void>((resolve) => {
      resolveSynced = resolve;
    });

    const watched = new SyncEngine({
      workspaceRoot: root,
      store: db,
      onSynced: (outcome) => {
        outcomes.push(outcome);
        if (outcome.relativePath.endsWith('TASK-200.md')) resolveSynced?.();
      },
    });

    await watched.start();
    await write('kanban/epics/e/TASK-200.md', taskFile('TASK-200', 'Watched'));
    await synced;
    await watched.stop();

    const seen = outcomes.find((o) => o.relativePath.endsWith('TASK-200.md'));
    expect(seen?.action).toBe('upserted');
    expect(await rows('work_items', 'kanban/epics/e/TASK-200.md')).toHaveLength(1);
  }, 60_000);

  it('reports a watcher-side failure instead of swallowing it', async () => {
    // A silently dropped sync leaves the mirror wrong with nothing to show.
    const failures: SyncOutcome[] = [];
    let resolveFailed: (() => void) | undefined;
    const failed = new Promise<void>((resolve) => {
      resolveFailed = resolve;
    });

    const watched = new SyncEngine({
      workspaceRoot: root,
      store: db,
      onSynced: (outcome) => {
        if (outcome.action === 'failed') {
          failures.push(outcome);
          resolveFailed?.();
        }
      },
    });

    await watched.start();
    await write('kanban/epics/e/TASK-201.md', '---\ntitle: no id\n---\n\nbody\n');
    await failed;
    await watched.stop();

    expect(failures[0]?.error).toMatch(/no id/);
  }, 60_000);
});

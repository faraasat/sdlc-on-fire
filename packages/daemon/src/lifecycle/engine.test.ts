import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applySchema, provisionPglite, type ProvisionedDatabase } from '@sdlc-on-fire/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  gatesMustPassGuard,
  LifecycleEngine,
  TransitionRefusedError,
  UnknownWorkItemError,
} from './engine.js';

/**
 * Drives the engine against the real schema in a real PGlite. The claim under
 * test is "a transition is legal only when the rows say so" — which is only
 * observable against the actual tables and their constraints.
 */

let db: ProvisionedDatabase;
let engine: LifecycleEngine;
const tempRoots: string[] = [];

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-life-'));
  tempRoots.push(root);
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
}, 90_000);

afterAll(async () => {
  await db.close().catch(() => undefined);
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
  await db.exec('DELETE FROM lifecycle_transitions; DELETE FROM gates; DELETE FROM work_items;');
  engine = new LifecycleEngine(db);
});

async function seed(
  id: string,
  stage: string,
  options: { preset?: string; workType?: string; status?: string } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, work_type, preset, file_path, content_hash)
     VALUES ($1, 'task', 't', $2, $3, $4, $5, $6, 'h');`,
    [
      id,
      options.status ?? 'Spec',
      stage,
      options.workType ?? 'feature',
      options.preset ?? 'standard',
      `kanban/${id}.md`,
    ],
  );
}

describe('structural rules', () => {
  it('allows the next stage on the ladder', async () => {
    await seed('TASK-001', 'discovery');
    // standard/feature: discovery → spec → decompose → …
    expect(await engine.canTransition('TASK-001', 'spec')).toEqual({ allowed: true });
  });

  it('refuses a stage that is not next', async () => {
    // Skipping would let an item reach `done` without passing the gates on the
    // stages in between — the entire mechanism this product exists to enforce.
    await seed('TASK-002', 'discovery');
    const decision = await engine.canTransition('TASK-002', 'implement');

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('structural:sequence');
  });

  it('refuses a stage absent from this item ladder', async () => {
    await seed('TASK-003', 'triage', { workType: 'bug', preset: 'lite' });
    const decision = await engine.canTransition('TASK-003', 'security_review');

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('structural:ladder');
  });

  it('refuses to move a terminal item', async () => {
    await seed('TASK-004', 'done', { status: 'Done' });
    const decision = await engine.canTransition('TASK-004', 'review');

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.guard).toBe('structural:terminal');
      expect(decision.reason).toContain('supersedes');
    }
  });

  it('reports an unknown work item rather than silently allowing it', async () => {
    await expect(engine.canTransition('TASK-999', 'spec')).rejects.toBeInstanceOf(
      UnknownWorkItemError,
    );
  });
});

describe('named guards', () => {
  it('names the guard that refused', async () => {
    await seed('TASK-010', 'discovery');
    engine.registerGuard('always-refuse', () => 'because');

    const decision = await engine.canTransition('TASK-010', 'spec');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.guard).toBe('always-refuse');
      expect(decision.reason).toBe('because');
    }
  });

  it('allows when every guard passes', async () => {
    await seed('TASK-011', 'discovery');
    engine.registerGuard('permissive', () => null);
    expect(await engine.canTransition('TASK-011', 'spec')).toEqual({ allowed: true });
  });

  it('runs structural checks before guards', async () => {
    // A guard must never be asked about a transition that is not on the ladder.
    await seed('TASK-012', 'done', { status: 'Done' });
    engine.registerGuard('should-not-run', () => {
      throw new Error('guard ran on a structurally illegal transition');
    });

    const decision = await engine.canTransition('TASK-012', 'review');
    expect(decision.allowed).toBe(false);
  });

  it('exposes registered guard names', () => {
    engine.registerGuard('b', () => null);
    engine.registerGuard('a', () => null);
    expect(engine.guardNames).toEqual(['a', 'b']);
  });
});

describe('gate guard', () => {
  it('allows when no gate is declared for the stage', async () => {
    await seed('TASK-020', 'discovery');
    engine.registerGuard('gates', gatesMustPassGuard());
    expect(await engine.canTransition('TASK-020', 'spec')).toEqual({ allowed: true });
  });

  it('blocks on a pending gate', async () => {
    await seed('TASK-021', 'discovery');
    await db.query(
      "INSERT INTO gates (work_item_id, gate_name, result) VALUES ($1, 'discovery', 'pending');",
      ['TASK-021'],
    );
    engine.registerGuard('gates', gatesMustPassGuard());

    const decision = await engine.canTransition('TASK-021', 'spec');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('gates');
  });

  it('allows once the gate passes', async () => {
    await seed('TASK-022', 'discovery');
    await db.query(
      "INSERT INTO gates (work_item_id, gate_name, result) VALUES ($1, 'discovery', 'pass');",
      ['TASK-022'],
    );
    engine.registerGuard('gates', gatesMustPassGuard());

    expect(await engine.canTransition('TASK-022', 'spec')).toEqual({ allowed: true });
  });
});

describe('performing a transition', () => {
  it('records the transition and derives the status', async () => {
    await seed('TASK-030', 'implement', { status: 'In Progress' });
    await engine.transition({ workItemId: 'TASK-030', to: 'test' });

    const [row] = await db.query<{ lifecycle_state: string; status: string }>(
      'SELECT lifecycle_state, status FROM work_items WHERE id = $1;',
      ['TASK-030'],
    );
    expect(row?.lifecycle_state).toBe('test');
    // `status` is a projection, derived here — never accepted from the caller.
    expect(row?.status).toBe('In Progress');

    const history = await engine.history('TASK-030');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: 'implement', to: 'test' });
  });

  it('stores the gate verdict alongside the transition', async () => {
    await seed('TASK-031', 'implement', { status: 'In Progress' });
    await engine.transition({
      workItemId: 'TASK-031',
      to: 'test',
      gateResult: { pass: true, missing: [], failures: [] },
    });

    const [row] = await db.query<{ gate_result: unknown }>(
      'SELECT gate_result FROM lifecycle_transitions WHERE work_item_id = $1;',
      ['TASK-031'],
    );
    expect(row?.gate_result).toMatchObject({ pass: true });
  });

  it('throws with the refusing guard rather than silently not moving', async () => {
    await seed('TASK-032', 'discovery');
    engine.registerGuard('nope', () => 'not yet');

    await expect(engine.transition({ workItemId: 'TASK-032', to: 'spec' })).rejects.toBeInstanceOf(
      TransitionRefusedError,
    );

    const [row] = await db.query<{ lifecycle_state: string }>(
      'SELECT lifecycle_state FROM work_items WHERE id = $1;',
      ['TASK-032'],
    );
    expect(row?.lifecycle_state).toBe('discovery');
  });

  it('walks a full lite/bug ladder end to end', async () => {
    await seed('TASK-040', 'triage', { workType: 'bug', preset: 'lite', status: 'Discovery' });

    await engine.transition({ workItemId: 'TASK-040', to: 'implement' });
    await engine.transition({ workItemId: 'TASK-040', to: 'done' });

    const [row] = await db.query<{ lifecycle_state: string; status: string }>(
      'SELECT lifecycle_state, status FROM work_items WHERE id = $1;',
      ['TASK-040'],
    );
    expect(row?.lifecycle_state).toBe('done');
    expect(row?.status).toBe('Done');

    // And it is now immutable.
    const decision = await engine.canTransition('TASK-040', 'review');
    expect(decision.allowed).toBe(false);
  });
});

describe('kanban projection', () => {
  it('groups items by column, not by stage', async () => {
    await seed('TASK-050', 'implement', { status: 'In Progress' });
    await seed('TASK-051', 'test', { status: 'In Progress' });
    await seed('TASK-052', 'review', { status: 'Review' });

    const board = await engine.board();
    // implement and test collapse into one column by design (§3.4).
    expect(board['In Progress']?.sort()).toEqual(['TASK-050', 'TASK-051']);
    expect(board['Review']).toEqual(['TASK-052']);
  });

  it('is empty for an empty mirror', async () => {
    expect(await engine.board()).toEqual({});
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applySchema,
  provisionPglite,
  PostgresStorageAdapter,
  type ProvisionedDatabase,
} from '@sdlc-on-fire/db';
import { LifecycleEngine } from './engine.js';
import {
  describeInvariants,
  LIFECYCLE_INVARIANTS,
  registerLifecycleInvariants,
} from './invariants.js';

/**
 * Lifecycle invariant guards (P1-GATE-03).
 *
 * Run against a real database because every one of these guards asks the store
 * a question — a stubbed store would be testing the stub's opinion of what a
 * claim or a transition record looks like.
 */

let db: ProvisionedDatabase;
let port: PostgresStorageAdapter;
let engine: LifecycleEngine;
let root: string;

async function seed(id: string, stage: string, preset = 'standard', workType = 'feature') {
  await port.upsertWorkItem({
    id,
    type: 'feature',
    title: id,
    status: 'To Do',
    lifecycleState: stage,
    preset,
    workType,
    filePath: `kanban/_inbox/${id}.md`,
    contentHash: 'h',
  });
}

const record = async (id: string, to: string) =>
  db.query(
    `INSERT INTO lifecycle_transitions (work_item_id, from_state, to_state) VALUES ($1, NULL, $2);`,
    [id, to],
  );

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'invariants-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
  port = await PostgresStorageAdapter.create(db);
}, 120_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  engine = new LifecycleEngine(db);
  registerLifecycleInvariants(engine);
});

describe('the invariant set is reviewable', () => {
  it('declares trigger, predicate and enforcement for every guard', () => {
    // An invariant nobody can enumerate is one nobody can review.
    for (const invariant of describeInvariants()) {
      expect(invariant.trigger.length, invariant.name).toBeGreaterThan(0);
      expect(invariant.predicate.length, invariant.name).toBeGreaterThan(0);
      expect(['block', 'warn']).toContain(invariant.enforcement);
      expect(invariant.reference.length, invariant.name).toBeGreaterThan(0);
    }
  });

  it('registers every declared invariant, with no silent omissions', () => {
    expect(engine.guardNames).toEqual(LIFECYCLE_INVARIANTS.map((i) => i.name).sort());
  });

  it('does not leak the check function into the reviewable rendering', () => {
    for (const invariant of describeInvariants()) {
      expect(invariant).not.toHaveProperty('check');
    }
  });
});

describe('claim-required-to-execute (ADR-0048)', () => {
  it('refuses entry to implement with no claim', async () => {
    await seed('FEAT-100', 'plan');
    await record('FEAT-100', 'spec');

    const decision = await engine.canTransition('FEAT-100', 'implement');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('claim-required-to-execute');
  });

  it('allows it once a claim is held', async () => {
    await seed('FEAT-101', 'plan');
    await record('FEAT-101', 'spec');
    await port.claim({ workItemId: 'FEAT-101', actor: 'agent-a', kind: 'agent', leaseMs: 60_000 });

    expect((await engine.canTransition('FEAT-101', 'implement')).allowed).toBe(true);
  });

  it('treats an expired lease as no claim', async () => {
    // Otherwise a crashed agent's stale claim would keep authorising work.
    await seed('FEAT-102', 'plan');
    await record('FEAT-102', 'spec');
    await port.claim({ workItemId: 'FEAT-102', actor: 'ghost', kind: 'agent', leaseMs: -1_000 });

    const decision = await engine.canTransition('FEAT-102', 'implement');
    expect(decision.allowed).toBe(false);
  });
});

describe('spec-before-implement', () => {
  it('refuses implement when no spec transition was ever recorded', async () => {
    await seed('FEAT-110', 'plan');
    await port.claim({ workItemId: 'FEAT-110', actor: 'a', kind: 'agent', leaseMs: 60_000 });

    const decision = await engine.canTransition('FEAT-110', 'implement');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('spec-before-implement');
  });

  it('does not apply to a ladder that has no spec stage', async () => {
    // A `lite` task never had a spec stage to skip, so demanding one would be
    // enforcing a rule that does not exist for it.
    await seed('TASK-110', 'implement', 'lite', 'task');
    await port.claim({ workItemId: 'TASK-110', actor: 'a', kind: 'agent', leaseMs: 60_000 });

    const decision = await engine.canTransition('TASK-110', 'done');
    expect(decision.allowed).toBe(true);
  });
});

describe('review-before-done', () => {
  it('refuses done without a recorded review, even from the right stage', async () => {
    // The ladder orders review before done, but a ladder is a route, not a
    // receipt — a stage written straight into the mirror leaves no record.
    await seed('FEAT-120', 'review');
    await port.claim({ workItemId: 'FEAT-120', actor: 'a', kind: 'agent', leaseMs: 60_000 });

    const decision = await engine.canTransition('FEAT-120', 'done');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('review-before-done');
  });

  it('allows done once the review transition is on record', async () => {
    await seed('FEAT-121', 'review');
    await record('FEAT-121', 'review');
    expect((await engine.canTransition('FEAT-121', 'done')).allowed).toBe(true);
  });
});

describe('human-approval-for-strict', () => {
  it('refuses done on a strict item with no human approval', async () => {
    await seed('FEAT-130', 'approval', 'strict');
    await record('FEAT-130', 'review');

    const decision = await engine.canTransition('FEAT-130', 'done');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.guard).toBe('human-approval-for-strict');
  });

  it('does not apply to standard-preset items', async () => {
    await seed('FEAT-131', 'review');
    await record('FEAT-131', 'review');
    expect((await engine.canTransition('FEAT-131', 'done')).allowed).toBe(true);
  });
});

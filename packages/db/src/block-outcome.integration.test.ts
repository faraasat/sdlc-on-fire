import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';

/**
 * The two triggers behind the adoption bar (P8-BAR-01, ADR-0063).
 *
 * `admitBlockOutcome` refuses an agent and refuses a passing gate, and it is
 * unit-tested. That is necessary and insufficient (ADR-0037): the refusals live
 * in the application layer, which is exactly the layer that would route around
 * them — by a bug, by a second write path added later, or by somebody inserting
 * directly. These tests go at the rows with raw SQL, deliberately bypassing
 * every check in `core`, and assert the database says no on its own.
 *
 * The same argument put `approvals_agent_never_approves` in the schema rather
 * than the daemon.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let db: ProvisionedDatabase;
let root: string;
let humanId: string;
let agentId: string;
let failedGate: number;
let passedGate: number;
let pendingGate: number;

async function insertGate(result: string | null): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `INSERT INTO gates (work_item_id, gate_name, result) VALUES ($1,$2,$3) RETURNING id;`,
    ['FEAT-001', `gate-${result ?? 'null'}`, result],
  );
  return Number(rows[0]?.id);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-bar-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);

  const human = await db.query<{ id: string }>(
    `INSERT INTO actors (kind, display_name, email) VALUES ('human','Dana','dana@example.com') RETURNING id;`,
  );
  humanId = String(human[0]?.id);
  const agent = await db.query<{ id: string }>(
    `INSERT INTO actors (kind, display_name) VALUES ('agent','implementer') RETURNING id;`,
  );
  agentId = String(agent[0]?.id);

  await db.query(
    `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
     VALUES ('FEAT-001','feature','A feature','In Progress','implement','kanban/FEAT-001.md','deadbeef')
     ON CONFLICT DO NOTHING;`,
  );

  failedGate = await insertGate('fail');
  passedGate = await insertGate('pass');
  pendingGate = await insertGate('pending');
}, 90_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

async function tag(gateId: number, actorId: string, outcome: string): Promise<void> {
  await db.query(`INSERT INTO gate_outcome_tags (gate_id, actor_id, outcome) VALUES ($1,$2,$3);`, [
    gateId,
    actorId,
    outcome,
  ]);
}

describe('gate_outcome_tags', () => {
  it('accepts a human judging a real block', async () => {
    await expect(tag(failedGate, humanId, 'valuable')).resolves.toBeUndefined();
    const rows = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM gate_outcome_tags WHERE gate_id = $1;',
      [failedGate],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('refuses an agent, whatever the application layer thinks', async () => {
    await expect(tag(failedGate, agentId, 'valuable')).rejects.toThrow(/agent/i);
  });

  it('refuses an agent tagging `nuisance` too', async () => {
    // The friction counter is what decides whether gates get loosened, so an
    // agent driving it down is the same corruption from the other direction.
    await expect(tag(failedGate, agentId, 'nuisance')).rejects.toThrow(/agent/i);
  });

  it('refuses a gate that passed', async () => {
    await expect(tag(passedGate, humanId, 'valuable')).rejects.toThrow(/did not block/i);
  });

  it('refuses a gate still pending', async () => {
    await expect(tag(pendingGate, humanId, 'valuable')).rejects.toThrow(/did not block/i);
  });

  it('names the actual result in the refusal rather than saying "invalid"', async () => {
    // Somebody tagging a pending gate is early, and somebody tagging a pass has
    // misunderstood the metric. A shared "invalid gate" message would send both
    // to the same wrong conclusion.
    await expect(tag(pendingGate, humanId, 'nuisance')).rejects.toThrow(/pending/);
  });

  it('refuses an outcome outside the vocabulary at the CHECK constraint', async () => {
    await expect(tag(failedGate, humanId, 'neutral')).rejects.toThrow();
  });

  it('allows the same actor to tag the same gate again — a changed mind is data', async () => {
    await tag(failedGate, humanId, 'nuisance');
    const rows = await db.query<{ outcome: string }>(
      'SELECT outcome FROM gate_outcome_tags WHERE gate_id = $1 AND actor_id = $2 ORDER BY id;',
      [failedGate, humanId],
    );
    expect(rows.map((row) => row.outcome)).toEqual(['valuable', 'nuisance']);
  });

  it('refuses a tag on a gate that does not exist', async () => {
    await expect(tag(999_999, humanId, 'valuable')).rejects.toThrow();
  });
});

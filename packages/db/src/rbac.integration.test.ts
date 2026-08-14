import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  capability,
  DEFAULT_ROLE_PERMISSIONS,
  HUMAN_ONLY_ACTIONS,
  PERMISSION_KEYS,
  ROLE_KEYS,
} from '@sdlc-on-fire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, seedRoles } from './migrate.js';
import { provisionPglite, type ProvisionedDatabase } from './pglite.js';

/**
 * The RBAC rows, against a real Postgres (P3-RBAC-01, ADR-0010).
 *
 * The unit tests prove `capability()` decides correctly. What they cannot prove
 * is that the policy it decides *from* is the policy the database holds — and
 * that is the seam this whole design rests on, because ADR-0010 chose rows over
 * a policy library precisely so the rules would be joinable SQL.
 */

const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let db: ProvisionedDatabase;
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-rbac-'));
  db = await provisionPglite({ workspaceRoot: root });
  await applySchema(db);
}, 90_000);

afterAll(async () => {
  await db.close();
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

/** The policy as the database holds it, read back through a join. */
async function policyFromDb(): Promise<Record<string, string[]>> {
  const rows = await db.query<{ role: string; permission: string }>(
    `SELECT r.key AS role, p.key AS permission
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
      ORDER BY r.key, p.key;`,
  );
  const table: Record<string, string[]> = {};
  for (const row of rows) (table[row.role] ??= []).push(row.permission);
  return table;
}

describe('the seed', () => {
  it('creates the eight roles and no more', async () => {
    const rows = await db.query<{ key: string }>('SELECT key FROM roles ORDER BY key;');
    expect(rows.map((row) => row.key)).toEqual([...ROLE_KEYS].sort());
  });

  it('creates the permission vocabulary', async () => {
    const rows = await db.query<{ key: string }>('SELECT key FROM permissions ORDER BY key;');
    expect(rows.map((row) => row.key)).toEqual([...PERMISSION_KEYS].sort());
  });

  it('writes the same table capability() decides from', async () => {
    // Not "some rows exist". The exact policy, both directions — a seed that
    // grants more than the constant is a privilege nobody reviewed, and one
    // that grants less is a permission that passes its unit test and fails in
    // the product.
    const fromDb = policyFromDb();
    const expected = Object.fromEntries(
      Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([role, keys]) => [role, [...keys].sort()]),
    );
    expect(await fromDb).toEqual(expected);
  });

  it('is idempotent', async () => {
    const before = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM role_permissions;',
    );
    await seedRoles(db);
    const after = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM role_permissions;',
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});

describe('capability() against the rows it models', () => {
  let human: string;
  let agent: string;

  beforeAll(async () => {
    const [h] = await db.query<{ id: string }>(
      `INSERT INTO actors (kind, display_name, email) VALUES ('human','Ada','ada@example.com')
       RETURNING id;`,
    );
    const [a] = await db.query<{ id: string }>(
      `INSERT INTO actors (kind, display_name, agent_target) VALUES ('agent','claude-code','claude-code')
       RETURNING id;`,
    );
    human = h?.id ?? '';
    agent = a?.id ?? '';
    await db.query(
      `INSERT INTO memberships (actor_id, role_id) SELECT $1, id FROM roles WHERE key = 'eng-lead';`,
      [human],
    );
  });

  it('agrees with a membership read back out of the database', async () => {
    const memberships = await db.query<{ role_key: string; expires_at: string | null }>(
      `SELECT r.key AS role_key, m.expires_at FROM memberships m
         JOIN roles r ON r.id = m.role_id WHERE m.actor_id = $1;`,
      [human],
    );
    const verdict = capability({
      actor: { id: human, kind: 'human', displayName: 'Ada' },
      action: 'approve',
      cardId: 'FEAT-1',
      memberships: memberships.map((row) => ({
        actorId: human,
        roleKey: row.role_key,
        expiresAt: row.expires_at ?? undefined,
      })),
      rolePermissions: await policyFromDb(),
      humanOnlyActions: HUMAN_ONLY_ACTIONS,
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(verdict.granted).toBe(true);
    expect(verdict.ground).toBe('role-permission');
  });

  it('refuses a membership the database says has expired', async () => {
    await db.query(
      `INSERT INTO memberships (actor_id, role_id, expires_at)
       SELECT $1, id, '2026-01-01T00:00:00Z' FROM roles WHERE key = 'qa';`,
      [human],
    );
    const rows = await db.query<{ role_key: string; expires_at: Date | null }>(
      `SELECT r.key AS role_key, m.expires_at FROM memberships m
         JOIN roles r ON r.id = m.role_id WHERE m.actor_id = $1 AND r.key = 'qa';`,
      [human],
    );
    const expiresAt = rows[0]?.expires_at;
    expect(expiresAt).not.toBeNull();
    const verdict = capability({
      actor: { id: human, kind: 'human', displayName: 'Ada' },
      action: 'reopen',
      cardId: 'FEAT-1',
      memberships: [
        { actorId: human, roleKey: 'qa', expiresAt: new Date(String(expiresAt)).toISOString() },
      ],
      rolePermissions: await policyFromDb(),
      humanOnlyActions: HUMAN_ONLY_ACTIONS,
      now: '2026-08-14T00:00:00.000Z',
    });
    expect(verdict.ground).toBe('expired-membership');
  });

  it('the database refuses a role-gated agent approval whatever capability() says', async () => {
    // The disposer, exercised rather than assumed. `capability()` refusing the
    // same thing is the two layers agreeing — not the reason it holds.
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('FEAT-RBAC-1','feature','t','In Progress','implement','kanban/rbac1.md','h')
       ON CONFLICT (id) DO NOTHING;`,
    );
    const [gate] = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('FEAT-RBAC-1','review','pending')
       RETURNING id;`,
    );
    await expect(
      db.query(
        `INSERT INTO approvals (gate_id, actor_id, role_id, decision)
         SELECT $1, $2, id, 'approve' FROM roles WHERE key = 'eng-lead';`,
        [gate?.id ?? 1, agent],
      ),
    ).rejects.toThrow(/agent/i);
  });

  it('lets the same approval through for a human', async () => {
    const [gate] = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('FEAT-RBAC-1','design','pending')
       RETURNING id;`,
    );
    await expect(
      db.query(
        `INSERT INTO approvals (gate_id, actor_id, role_id, decision)
         SELECT $1, $2, id, 'approve' FROM roles WHERE key = 'eng-lead';`,
        [gate?.id ?? 1, human],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a membership for an actor that does not exist', async () => {
    await expect(
      db.query(
        `INSERT INTO memberships (actor_id, role_id)
         SELECT '00000000-0000-0000-0000-000000000000'::uuid, id FROM roles WHERE key = 'pm';`,
      ),
    ).rejects.toThrow();
  });

  it('refuses the same membership twice', async () => {
    await expect(
      db.query(
        `INSERT INTO memberships (actor_id, role_id) SELECT $1, id FROM roles WHERE key = 'eng-lead';`,
        [human],
      ),
    ).rejects.toThrow();
  });
});

describe('no agent holds a role (P3-RBAC-04)', () => {
  let agent: string;
  let human: string;

  beforeAll(async () => {
    const [a] = await db.query<{ id: string }>(
      `INSERT INTO actors (kind, display_name, agent_target) VALUES ('agent','codex','codex')
       RETURNING id;`,
    );
    const [h] = await db.query<{ id: string }>(
      `INSERT INTO actors (kind, display_name, email) VALUES ('human','Grace','grace@example.com')
       RETURNING id;`,
    );
    agent = a?.id ?? '';
    human = h?.id ?? '';
  });

  it('refuses to give an agent a membership at all', async () => {
    // ADR-0010's wording is structural. The `approvals` trigger sits one table
    // downstream and only fires on a role-gated approval, which leaves the
    // *state* reachable: an agent holding eng-lead shows up in every roster
    // query as somebody who could approve.
    await expect(
      db.query(
        `INSERT INTO memberships (actor_id, role_id) SELECT $1, id FROM roles WHERE key = 'eng-lead';`,
        [agent],
      ),
    ).rejects.toThrow(/cannot hold a role/);
  });

  it('refuses on update as well as insert', async () => {
    // Otherwise the rule is one UPDATE away from being bypassed: grant a human,
    // then re-point the row at an agent.
    await db.query(
      `INSERT INTO memberships (actor_id, role_id) SELECT $1, id FROM roles WHERE key = 'designer';`,
      [human],
    );
    await expect(
      db.query(`UPDATE memberships SET actor_id = $1 WHERE actor_id = $2;`, [agent, human]),
    ).rejects.toThrow(/cannot hold a role/);
  });

  it('leaves gate_policies.required_role unable to resolve to an agent', async () => {
    // The property the phase file actually asks for, asked as a query rather
    // than asserted about the trigger.
    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM memberships m
         JOIN actors a ON a.id = m.actor_id WHERE a.kind = 'agent';`,
    );
    expect(rows[0]?.count).toBe(0);
  });

  it('still refuses an agent approval, because both triggers stay', async () => {
    // Belt and braces. A row arriving through a restore from before the
    // memberships trigger existed must still not become approving.
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, file_path, content_hash)
       VALUES ('FEAT-RBAC-4','feature','t','In Progress','implement','kanban/rbac4.md','h')
       ON CONFLICT (id) DO NOTHING;`,
    );
    const [gate] = await db.query<{ id: number }>(
      `INSERT INTO gates (work_item_id, gate_name, result) VALUES ('FEAT-RBAC-4','review','pending')
       RETURNING id;`,
    );
    await expect(
      db.query(
        `INSERT INTO approvals (gate_id, actor_id, role_id, decision)
         SELECT $1, $2, id, 'approve' FROM roles WHERE key = 'eng-lead';`,
        [gate?.id ?? 1, agent],
      ),
    ).rejects.toThrow(/agent/i);
  });
});

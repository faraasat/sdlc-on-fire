import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, ROLE_KEYS } from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc access` against the **built binary** and a real workspace (P3-RBAC-01).
 *
 * The unit tests prove the decision, and the db suite proves the rows. Neither
 * proves a person can reach any of it — which is where every defect this
 * project has found actually lived.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

/** Runs the CLI, returning stdout and exit code rather than throwing on non-zero. */
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-access-'));
  await run('git', ['init'], { cwd: root });
  await run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Ada Lovelace'], { cwd: root });
  await run('node', [CLI, '-C', root, 'init'], { cwd: root });
}, 120_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('sdlc access policy', () => {
  it('reads the seeded table out of the database', async () => {
    const { stdout, code } = await sdlc('access', 'policy', '--json');
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      roles: string[];
      permissions: string[];
      table: Record<string, string[]>;
      drift: string[];
    };
    expect(result.roles).toEqual([...ROLE_KEYS].sort());
    expect(result.permissions).toEqual([...PERMISSION_KEYS].sort());
    expect(result.table['stakeholder']).toEqual(['comment']);
  }, 60_000);

  it('reports no drift on a workspace `sdlc init` just built', async () => {
    // The seed runs inside `init`. If this ever fails, the code and the rows
    // have parted company on a machine where nobody edited either — which is
    // the only way this failure ever actually arrives.
    const { stdout } = await sdlc('access', 'policy', '--json');
    expect((JSON.parse(stdout) as { drift: string[] }).drift).toEqual([]);
  }, 60_000);

  it('says out loud which actions no agent can take', async () => {
    const { stdout } = await sdlc('access', 'policy');
    expect(stdout).toContain('Human-only:');
    expect(stdout).toContain('an agent holding the role still cannot');
  }, 60_000);
});

describe('sdlc access whoami', () => {
  it('resolves the human actor from git config', async () => {
    // `created` is no longer asserted true here. `sdlc init` now bootstraps the
    // actor eagerly (P3-UI-01) because the UI resolves identity without ever
    // running `whoami`, and a board on a fresh workspace was answering
    // "nobody". So by the time `whoami` runs, the actor usually exists — and
    // pinning `created: true` was pinning the old lazy timing rather than any
    // property of the command. What must hold is the identity itself.
    const { stdout, code } = await sdlc('access', 'whoami', '--json');
    expect(code).toBe(0);
    const result = JSON.parse(stdout) as {
      created: boolean;
      actor: { kind: string; displayName: string; roles: unknown[] };
    };
    expect(result.actor.kind).toBe('human');
    expect(result.actor.displayName).toBe('Ada Lovelace');
    expect(result.actor.roles).toEqual([]);
  }, 60_000);

  it('mints exactly one actor however many times it is asked', async () => {
    // The property the old `created: true` assertion was reaching for, stated
    // in a way that does not depend on who bootstrapped first.
    const first = JSON.parse((await sdlc('access', 'whoami', '--json')).stdout) as {
      actor: { id?: string; displayName: string };
    };
    const second = JSON.parse((await sdlc('access', 'whoami', '--json')).stdout) as {
      actor: { id?: string; displayName: string };
    };
    expect(second.actor.displayName).toBe(first.actor.displayName);
    if (first.actor.id !== undefined) expect(second.actor.id).toBe(first.actor.id);
  }, 60_000);

  it('finds the same actor the second time rather than minting another', async () => {
    const { stdout } = await sdlc('access', 'whoami', '--json');
    expect((JSON.parse(stdout) as { created: boolean }).created).toBe(false);
  }, 60_000);
});

describe('sdlc access grant and check', () => {
  it('refuses an action before any role is granted', async () => {
    const { stdout, code } = await sdlc('access', 'check', 'ada@example.test', 'advance', 'TASK-1');
    expect(code).toBe(1);
    expect(stdout).toContain('may not');
  }, 60_000);

  it('grants a role and then allows the action', async () => {
    expect((await sdlc('access', 'grant', 'ada@example.test', 'eng-lead')).code).toBe(0);
    const { stdout, code } = await sdlc('access', 'check', 'ada@example.test', 'advance', 'TASK-1');
    expect(code).toBe(0);
    expect(stdout).toContain('role "eng-lead"');
  }, 60_000);

  it('honours an --until date that has already passed', async () => {
    // The end-to-end version of the ADR-0035 property: the date is stored, read
    // back, and acted on. A CLI that accepted `--until` and dropped it would
    // pass every unit test in `core`.
    await sdlc(
      'access',
      'grant',
      'ada@example.test',
      'eng-lead',
      '--until',
      '2020-01-01T00:00:00Z',
    );
    const { stdout, code } = await sdlc('access', 'check', 'ada@example.test', 'advance', 'TASK-1');
    expect(code).toBe(1);
    expect(stdout).toContain('expired');

    await sdlc(
      'access',
      'grant',
      'ada@example.test',
      'eng-lead',
      '--until',
      '2099-01-01T00:00:00Z',
    );
    expect((await sdlc('access', 'check', 'ada@example.test', 'advance', 'TASK-1')).code).toBe(0);
  }, 90_000);

  it('refuses a role outside the capped eight', async () => {
    const { stdout, code } = await sdlc('access', 'grant', 'ada@example.test', 'release-manager');
    expect(code).not.toBe(0);
    expect(stdout).toContain('ADR-0010');
  }, 60_000);

  it('refuses an action nobody defined', async () => {
    const { stdout, code } = await sdlc('access', 'check', 'ada@example.test', 'deploy', 'TASK-1');
    expect(code).not.toBe(0);
    expect(stdout).toContain('known actions');
  }, 60_000);

  it('refuses an actor nobody has heard of', async () => {
    const { stdout, code } = await sdlc('access', 'check', 'nobody@example.test', 'advance', 'T-1');
    expect(code).not.toBe(0);
    expect(stdout).toContain('no actor matches');
  }, 60_000);

  it('grants every action the seeded eng-lead row says it should', async () => {
    for (const action of DEFAULT_ROLE_PERMISSIONS['eng-lead']) {
      const { code } = await sdlc('access', 'check', 'ada@example.test', action, 'TASK-1');
      expect(code, action).toBe(0);
    }
  }, 120_000);
});

describe('no agent holds a role (P3-RBAC-04)', () => {
  it('refuses to grant a role to an agent, and says why', async () => {
    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      await db.query(
        `INSERT INTO actors (kind, display_name, agent_target) VALUES ('agent','codex','codex')
         ON CONFLICT DO NOTHING;`,
      );
    } finally {
      await db.close();
    }

    // Refused in the CLI as well as by the trigger, so the message explains the
    // model rather than surfacing a raise from plpgsql.
    const { stdout, code } = await sdlc('access', 'grant', 'codex', 'eng-lead');
    expect(code).not.toBe(0);
    expect(stdout).toContain('ADR-0010');
    expect(stdout).toContain('assignee');
  }, 90_000);

  it('reports an agent that already holds one as a violation', async () => {
    // The trigger stops new rows; a database restored from before it existed
    // can still hold one, and an agent carrying a role appears in every roster
    // query as somebody who could approve.
    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      await db.query(
        'ALTER TABLE memberships DISABLE TRIGGER memberships_agents_hold_no_roles_trg;',
      );
      await db.query(
        `INSERT INTO memberships (actor_id, role_id)
         SELECT a.id, r.id FROM actors a, roles r WHERE a.display_name = 'codex' AND r.key = 'qa'
         ON CONFLICT DO NOTHING;`,
      );
      await db.query(
        'ALTER TABLE memberships ENABLE TRIGGER memberships_agents_hold_no_roles_trg;',
      );
    } finally {
      await db.close();
    }

    const { stdout, code } = await sdlc('access', 'policy');
    expect(code).toBe(1);
    expect(stdout).toContain('agent "codex" holds role "qa"');
  }, 90_000);
});

describe('grants lapse on their own, and the lapse is recorded (P3-RBAC-07)', () => {
  it('lists an indefinite grant as live', async () => {
    await sdlc('access', 'grant', 'ada@example.test', 'designer');
    const { stdout } = await sdlc('access', 'grants', '--json');
    const result = JSON.parse(stdout) as { grants: { roleKey: string; state: string }[] };
    expect(result.grants.find((g) => g.roleKey === 'designer')?.state).toBe('live');
  }, 90_000);

  it('warns before a grant lapses, not after', async () => {
    // `expiring` is the only state a person can still act on. A column that
    // only ever reads live-or-lapsed tells you at the moment it is too late.
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    await sdlc('access', 'grant', 'ada@example.test', 'qa', '--until', soon);
    const { stdout } = await sdlc('access', 'grants', '--json');
    const result = JSON.parse(stdout) as { grants: { roleKey: string; state: string }[] };
    expect(result.grants.find((g) => g.roleKey === 'qa')?.state).toBe('expiring');
  }, 90_000);

  it('records a lapse in the audit log, exactly once', async () => {
    // A grant that expires by clock produces no event of its own, and "it just
    // stopped working" is not an audit trail.
    await sdlc(
      'access',
      'grant',
      'ada@example.test',
      'security',
      '--until',
      '2020-01-01T00:00:00Z',
    );
    const first = JSON.parse((await sdlc('access', 'grants', '--json')).stdout) as {
      recorded: string[];
    };
    expect(first.recorded).toHaveLength(1);

    const second = JSON.parse((await sdlc('access', 'grants', '--json')).stdout) as {
      recorded: string[];
    };
    expect(second.recorded).toEqual([]);

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const rows = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM audit_log WHERE action = 'MEMBERSHIP_EXPIRED';`,
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await db.close();
    }
  }, 120_000);

  it('names the role that just lost its last holder, and exits non-zero', async () => {
    // The deadlock ADR-0035 is actually about, stated as the thing that breaks
    // rather than as the row that expired.
    const { stdout, code } = await sdlc('access', 'grants');
    expect(code).toBe(1);
    expect(stdout).toContain('No live holder for: security');
    expect(stdout).toContain('cannot open');
  }, 90_000);

  it('stops reporting the role once somebody live holds it again', async () => {
    await sdlc('access', 'grant', 'ada@example.test', 'security');
    const { stdout } = await sdlc('access', 'grants', '--json');
    expect((JSON.parse(stdout) as { uncovered: string[] }).uncovered).toEqual([]);
  }, 90_000);
});

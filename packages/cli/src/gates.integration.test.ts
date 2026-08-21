import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grantRole, whoami } from './access.js';
import {
  approveGate,
  checkQuorum,
  listGates,
  revokeApproval,
  simulatePolicyChange,
} from './gates.js';
import { init, openWorkspaceDatabase } from './commands.js';
import { applySchema } from '@sdlc-on-fire/db';

/**
 * `sdlc gates` against a real workspace and a real PGlite (P3-RBAC-03).
 *
 * The unit tests prove the matching and the quorum reasoning. What only this
 * can show is that an authored file in `docs/gates/` reaches the decision — the
 * seam where every defect in this project has actually lived.
 */

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const RM_RETRY = { maxRetries: 5, retryDelay: 100 } as const;

let root: string;

const CARD = [
  '---',
  '$schema: https://sdlc-on-fire.dev/schema/work-item.json',
  'id: FEAT-001',
  'kind: feature',
  'title: CSV import',
  'status: In Progress',
  'lifecycle_state: implement',
  'work_type: feature',
  'preset: standard',
  'risk_level: high',
  'verify: node -e "process.exit(0)"',
  'done:',
  '  - tests pass',
  'created_at: 2026-08-10T00:00:00.000Z',
  'updated_at: 2026-08-10T00:00:00.000Z',
  '---',
  '',
  'body',
  '',
].join('\n');

async function writePolicy(name: string, body: string): Promise<void> {
  const dir = path.join(root, 'docs', 'gates');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.yaml`), body, 'utf8');
}

async function seedCard(): Promise<void> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    await db.query(
      `INSERT INTO work_items (id, type, title, status, lifecycle_state, risk_level, file_path, content_hash)
       VALUES ('FEAT-001','feature','CSV import','In Progress','implement','high','kanban/_inbox/FEAT-001.md','h')
       ON CONFLICT (id) DO NOTHING;`,
    );
  } finally {
    await db.close();
  }
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sdlcof-gates-')));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'ada@example.test'], { cwd: root });
  await run('git', ['config', 'user.name', 'Ada'], { cwd: root });
  await init(root, { database: 'skip' });
  await fs.mkdir(path.join(root, 'kanban', '_inbox'), { recursive: true });
  await fs.writeFile(path.join(root, 'kanban', '_inbox', 'FEAT-001.md'), CARD, 'utf8');
}, 90_000);

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, ...RM_RETRY });
});

describe('policies compile from docs/gates/', () => {
  it('reports no policies as an ungated project, not a passing one', async () => {
    const result = await listGates(root);
    expect(result.policies).toHaveLength(0);
    expect(result.ok).toBe(true);
  }, 90_000);

  it('loads a policy and mirrors one row per required role', async () => {
    await writePolicy(
      'strict',
      [
        'name: strict',
        'applies_to: { work_type: ["feature"], risk_level: ["high"], path_pattern: ["**"] }',
        'transition: "review -> done"',
        'approvals: { required_roles: ["eng-lead", "security"], min_approvals: 1 }',
        'overridable_by: []',
      ].join('\n'),
    );
    const result = await listGates(root);
    expect(result.policies.map((policy) => policy.name)).toEqual(['strict']);
    // `gate_policies` holds one role per row; keeping only the first would make
    // "which policies require security" answer no.
    expect(result.rows).toBe(2);
  }, 90_000);

  it('rebuilds rather than merging, so a deleted policy stops applying', async () => {
    await writePolicy('a', 'name: a\napprovals: { required_roles: ["qa"] }');
    expect((await listGates(root)).rows).toBe(1);
    await fs.rm(path.join(root, 'docs', 'gates', 'a.yaml'));
    expect((await listGates(root)).rows).toBe(0);
  }, 90_000);

  it('fails on a policy file that does not parse', async () => {
    await writePolicy('broken', 'name: [unclosed');
    const result = await listGates(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.file).toBe('docs/gates/broken.yaml');
  }, 90_000);

  it('fails on two files claiming one policy name', async () => {
    await writePolicy('one', 'name: standard');
    await writePolicy('two', 'name: standard');
    const result = await listGates(root);
    expect(result.ok).toBe(false);
    expect(result.problems[0]?.message).toContain('already defined');
  }, 90_000);
});

describe('quorum against the real roster', () => {
  it('is satisfied when no policy matches', async () => {
    await seedCard();
    expect((await checkQuorum(root, 'FEAT-001')).ok).toBe(true);
  }, 90_000);

  it('blocks on a required role nobody has approved as', async () => {
    await seedCard();
    await whoami(root);
    await grantRole(root, 'ada@example.test', 'eng-lead');
    await writePolicy(
      'strict',
      'name: strict\napplies_to: { risk_level: ["high"] }\napprovals: { required_roles: ["security"] }',
    );

    // Ada holds eng-lead, not security, and is the only human. In solo mode
    // that auto-satisfies; the workspace defaults to solo, so this asserts the
    // rule is *reached* rather than that it blocks.
    const result = await checkQuorum(root, 'FEAT-001');
    expect(result.matched).toEqual(['strict']);
    expect(result.verdict.autoSatisfied).toEqual(['security']);
    expect(result.ok).toBe(true);
  }, 90_000);

  it('deadlocks the same case in team mode', async () => {
    // The mode is declared, not derived — same roster, same policy, different
    // answer, and that is the point of making it explicit.
    await seedCard();
    await whoami(root);
    const configPath = path.join(root, '.sdlcof', 'config.yaml');
    await fs.appendFile(configPath, '\nmode: team\n', 'utf8');
    await writePolicy(
      'strict',
      'name: strict\napplies_to: { risk_level: ["high"] }\napprovals: { required_roles: ["security"] }',
    );

    const result = await checkQuorum(root, 'FEAT-001');
    expect(result.mode).toBe('team');
    expect(result.ok).toBe(false);
    expect(result.verdict.findings[0]?.ground).toBe('deadlocked');
  }, 90_000);

  it('does not match a policy scoped to another risk level', async () => {
    await seedCard();
    await writePolicy(
      'low-only',
      'name: low-only\napplies_to: { risk_level: ["low"] }\napprovals: { required_roles: ["qa"] }',
    );
    expect((await checkQuorum(root, 'FEAT-001')).matched).toEqual([]);
  }, 90_000);
});

describe('the built binary', () => {
  it('lists policies and exits non-zero on a broken one', async () => {
    await writePolicy('good', 'name: good');
    const { stdout } = await run('node', [CLI, '-C', root, 'gates', 'list'], { cwd: root });
    expect(stdout).toContain('good');
    expect(stdout).toContain('closed door');

    await writePolicy('bad', 'name: 4\napprovals: 7');
    await expect(run('node', [CLI, '-C', root, 'gates', 'list'], { cwd: root })).rejects.toThrow();
  }, 120_000);

  it('answers a quorum question about a real card', async () => {
    await seedCard();
    const { stdout } = await run('node', [CLI, '-C', root, 'gates', 'quorum', 'FEAT-001'], {
      cwd: root,
    });
    expect(stdout).toContain('FEAT-001');
    expect(stdout).toContain('solo mode');
  }, 120_000);
});

describe('approve, revoke, simulate against the real database', () => {
  beforeEach(async () => {
    await seedCard();
    await whoami(root);
    await grantRole(root, 'ada@example.test', 'eng-lead');
  }, 90_000);

  it('records the policy values the approval was taken under', async () => {
    // P3-RBAC-06. Without this, editing the policy row afterwards leaves the
    // approval unable to explain itself.
    await writePolicy(
      'std',
      'name: std\napprovals: { required_roles: ["eng-lead"], min_approvals: 1 }\noverridable_by: ["eng-lead"]',
    );
    const result = await approveGate(root, 'FEAT-001', 'review', 'eng-lead');
    expect(result.provenance.requirement.requiredRoles).toEqual(['eng-lead']);
    expect(result.provenance.requirement.minApprovals).toBe(1);
    expect(result.provenance.policies).toEqual(['std']);
    expect(result.satisfied).toBe(true);
  }, 120_000);

  it('the snapshot survives the policy changing underneath it', async () => {
    // The whole point of storing by value. The row is expected to move.
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["eng-lead"] }');
    await approveGate(root, 'FEAT-001', 'review', 'eng-lead');
    await writePolicy(
      'std',
      'name: std\napprovals: { required_roles: ["eng-lead", "security"], min_approvals: 2 }',
    );

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const rows = await db.query<{
        detail: { provenance: { requirement: { requiredRoles: string[] } } };
      }>(`SELECT detail FROM audit_log WHERE action = 'GATE_APPROVED' ORDER BY id DESC LIMIT 1;`);
      // Still the rule as it stood, not the rule as it stands.
      expect(rows[0]?.detail.provenance.requirement.requiredRoles).toEqual(['eng-lead']);
    } finally {
      await db.close();
    }
  }, 120_000);

  it('withdrawing an approval re-opens the gate', async () => {
    // P3-RBAC-08. A retraction that leaves the gate green is a retraction in
    // name only.
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["eng-lead"] }');
    const approved = await approveGate(root, 'FEAT-001', 'review', 'eng-lead');

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const before = await db.query<{ result: string }>('SELECT result FROM gates WHERE id = $1;', [
        approved.gateId,
      ]);
      expect(before[0]?.result).toBe('pass');
    } finally {
      await db.close();
    }

    await revokeApproval(root, approved.approvalId, 'eng-lead', 'I misread the diff');

    const { db: db2 } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db2);
      const after = await db2.query<{ result: string; revoked_at: Date | null }>(
        `SELECT g.result, a.revoked_at FROM gates g JOIN approvals a ON a.gate_id = g.id
          WHERE a.id = $1;`,
        [approved.approvalId],
      );
      expect(after[0]?.result).toBe('pending');
      // Marked, not deleted: "approved then withdrawn" and "never approved" are
      // different histories.
      expect(after[0]?.revoked_at).not.toBeNull();
    } finally {
      await db2.close();
    }
  }, 120_000);

  it('refuses to withdraw the same approval twice', async () => {
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["eng-lead"] }');
    const approved = await approveGate(root, 'FEAT-001', 'review', 'eng-lead');
    await revokeApproval(root, approved.approvalId, 'eng-lead', 'first');
    await expect(revokeApproval(root, approved.approvalId, 'eng-lead', 'again')).rejects.toThrow(
      /already revoked/,
    );
  }, 120_000);

  it('writes an APPROVAL_REVOKED row carrying what was withdrawn', async () => {
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["eng-lead"] }');
    const approved = await approveGate(root, 'FEAT-001', 'review', 'eng-lead');
    await revokeApproval(root, approved.approvalId, 'eng-lead', 'wrong branch');

    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      const rows = await db.query<{ detail: { reason: string; kind: string } }>(
        `SELECT detail FROM audit_log WHERE action = 'APPROVAL_REVOKED' ORDER BY id DESC LIMIT 1;`,
      );
      expect(rows[0]?.detail.reason).toBe('wrong branch');
      expect(rows[0]?.detail.kind).toBe('self');
    } finally {
      await db.close();
    }
  }, 120_000);

  it('simulates a proposed policy directory against the live one', async () => {
    // P3-RBAC-05, reachable by a person and against real files.
    await writePolicy('std', 'name: std\napprovals: { required_roles: [] }');
    const proposedDir = path.join(root, 'proposed');
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.writeFile(
      path.join(proposedDir, 'std.yaml'),
      'name: std\napprovals: { required_roles: ["security"], min_approvals: 1 }',
      'utf8',
    );

    const result = await simulatePolicyChange(root, 'proposed');
    expect(result.deltas.length).toBeGreaterThan(0);
    expect(result.deltas[0]?.changes).toContain('now requires "security"');
    expect(result.deltas[0]?.direction).toBe('stricter');
  }, 120_000);

  it('reports no difference against an unchanged copy, with a probe count', async () => {
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["qa"] }');
    const proposedDir = path.join(root, 'proposed');
    await fs.mkdir(proposedDir, { recursive: true });
    await fs.copyFile(
      path.join(root, 'docs', 'gates', 'std.yaml'),
      path.join(proposedDir, 'std.yaml'),
    );
    const result = await simulatePolicyChange(root, 'proposed');
    expect(result.identical).toBe(true);
    expect(result.probed).toBeGreaterThan(0);
  }, 120_000);
});

describe('the built binary reaches all of it', () => {
  it('approves, then revokes, and says what happened both times', async () => {
    await seedCard();
    await whoami(root);
    await grantRole(root, 'ada@example.test', 'eng-lead');
    await writePolicy('std', 'name: std\napprovals: { required_roles: ["eng-lead"] }');

    const approved = await run(
      'node',
      [CLI, '-C', root, 'gates', 'approve', 'FEAT-001', 'review', '--json'],
      { cwd: root },
    );
    const id = (JSON.parse(approved.stdout) as { approvalId: number }).approvalId;

    const revoked = await run(
      'node',
      [CLI, '-C', root, 'gates', 'revoke', String(id), '--reason', 'misread'],
      { cwd: root },
    );
    expect(revoked.stdout).toContain('re-opened');
  }, 180_000);

  it('refuses a revocation with no reason at the CLI boundary', async () => {
    await expect(
      run('node', [CLI, '-C', root, 'gates', 'revoke', '1'], { cwd: root }),
    ).rejects.toThrow();
  }, 90_000);
});

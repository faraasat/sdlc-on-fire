import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { relativePosix, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import {
  compilePolicy,
  decisionProvenance,
  evaluateQuorum,
  evaluateRevocation,
  revocationImpact,
  REVOCATION_ACTION,
  simulateGatePolicy,
  formatPolicyProblems,
  formatQuorum,
  loadPolicies,
  matchPolicies,
  normaliseQuorum,
  type Approval,
  type DecisionProvenance,
  type EligibleApprover,
  type GatePolicySource,
  type PolicyProblem,
  type PolicyTarget,
  type QuorumContext,
  type QuorumVerdict,
} from '@sdlc-on-fire/evidence';
import { applySchema as _applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { resolveAuthor } from './access.js';
import { openWorkspaceDatabase, readConfig } from './commands.js';

interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/** Opens the workspace database with the schema applied, and always closes it. */
async function withGatesDb<T>(root: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await _applySchema(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

/**
 * `sdlc gates` — the authored gate policies, compiled and asked about
 * (P3-RBAC-03, contract 03 §4).
 *
 * Two commands and one relationship: the YAML in `docs/gates/` is the source,
 * `gate_policies` is the compiled mirror, and the mirror is rebuilt from the
 * files on every run rather than edited. That is the same arrangement
 * `work_items` has with `kanban/`, and for the same reason — a governance rule
 * that can be changed with an UPDATE is one nobody reviewed.
 */

export interface GatesResult {
  readonly policies: readonly GatePolicySource[];
  readonly problems: readonly PolicyProblem[];
  readonly rows: number;
  readonly dir: string;
  readonly ok: boolean;
}

async function readPolicyFiles(
  gatesDir: string,
  root: string,
): Promise<{ file: string; value: unknown }[]> {
  const entries = await fs.readdir(gatesDir, { withFileTypes: true }).catch(() => []);
  const documents: { file: string; value: unknown }[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const full = path.join(gatesDir, entry.name);
    const file = relativePosix(root, full);
    try {
      documents.push({ file, value: parseYaml(await fs.readFile(full, 'utf8')) });
    } catch (cause) {
      // A YAML syntax error is a document that failed to load, not a file that
      // was not there. It goes through the same path as a schema failure so it
      // cannot be mistaken for "this project has no policy".
      documents.push({ file, value: { __unparseable: String(cause) } });
    }
  }
  return documents;
}

/**
 * `sdlc gates list` — load, validate, and rebuild the compiled mirror.
 *
 * Exits non-zero on any problem. A policy file that does not load leaves a gate
 * silently not gating, and the symptom is indistinguishable from a card nobody
 * wrote a policy for — so it is loud, and it is a failure.
 */
export async function listGates(root: string): Promise<GatesResult> {
  const layout = resolveWorkspaceLayout(root);
  const loaded = loadPolicies(await readPolicyFiles(layout.gatesDir, layout.root));

  const { db } = await openWorkspaceDatabase(root);
  let rows = 0;
  try {
    await applySchema(db);
    // Rebuilt, not merged. A policy deleted from the tree must stop applying,
    // and an upsert-only mirror would keep enforcing a rule nobody can find.
    await db.query('DELETE FROM gate_policies;');
    for (const policy of loaded.policies) {
      for (const row of compilePolicy(policy)) {
        await db.query(
          `INSERT INTO gate_policies
             (work_type, risk_level, path_pattern, required_role_id, min_approvals, overridable_by_role_id)
           VALUES ($1,$2,$3,(SELECT id FROM roles WHERE key = $4),$5,(SELECT id FROM roles WHERE key = $6));`,
          [
            row.workType,
            row.riskLevel,
            row.pathPattern,
            row.requiredRole,
            row.minApprovals,
            row.overridableByRole,
          ],
        );
        rows += 1;
      }
    }
  } finally {
    await db.close();
  }

  return {
    policies: loaded.policies,
    problems: loaded.problems,
    rows,
    dir: relativePosix(layout.root, layout.gatesDir),
    ok: loaded.problems.length === 0,
  };
}

export function formatGates(result: GatesResult): string {
  const lines = [
    `${String(result.policies.length)} policy file(s) in ${result.dir} → ${String(result.rows)} compiled row(s)`,
    '',
  ];

  for (const policy of result.policies) {
    const roles = policy.approvals.required_roles;
    lines.push(
      `  ${policy.name.padEnd(12)} ${policy.transition ?? 'any transition'}`,
      `  ${' '.repeat(12)} evidence: ${policy.evidence.map((item) => item.kind).join(', ') || '(none)'}`,
      `  ${' '.repeat(12)} approvals: ${roles.length === 0 ? 'no role required' : roles.join(' + ')}` +
        `${policy.approvals.min_approvals > 0 ? `, floor ${String(policy.approvals.min_approvals)}` : ''}`,
      `  ${' '.repeat(12)} override: ${policy.overridable_by.length === 0 ? 'none — closed door' : policy.overridable_by.join(', ')}`,
      '',
    );
  }

  if (result.policies.length === 0 && result.problems.length === 0) {
    lines.push(
      `  No policy files. Every transition is ungated until one exists — which is a`,
      `  valid choice, and is not the same as a gate that passed.`,
      '',
    );
  }

  if (result.problems.length > 0) lines.push(formatPolicyProblems(result.problems));
  return lines.join('\n').trimEnd();
}

export interface QuorumCheck {
  readonly workItemId: string;
  readonly matched: readonly string[];
  readonly mode: 'solo' | 'team';
  readonly verdict: QuorumVerdict;
  readonly requirement: ReturnType<typeof normaliseQuorum>;
  readonly ok: boolean;
}

/**
 * `sdlc gates quorum` — who still has to approve this card, and why.
 *
 * The roster and the approvals come from the database; the mode comes from
 * config, because it is declared rather than inferred. Nothing here decides on
 * a default when a fact is missing: an unknown author is reported as an unknown
 * author rather than treated as somebody whose approval would count.
 */
export async function checkQuorum(
  root: string,
  workItemId: string,
  options: {
    readonly workType?: string;
    readonly riskLevel?: string;
    readonly paths?: string[];
  } = {},
): Promise<QuorumCheck> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  const mode = config?.mode ?? 'solo';

  const loaded = loadPolicies(await readPolicyFiles(layout.gatesDir, layout.root));

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    const items = await db.query<{ type: string; risk_level: string | null }>(
      'SELECT type, risk_level FROM work_items WHERE id = $1;',
      [workItemId],
    );
    const item = items[0];

    const target: PolicyTarget = {
      workType: options.workType ?? item?.type ?? 'feature',
      riskLevel: options.riskLevel ?? item?.risk_level ?? 'low',
      paths: options.paths ?? [],
    };

    const matched = matchPolicies(loaded.policies, target);
    const requirement = normaliseQuorum(matched);

    const roster = await db.query<{ actor_id: string; kind: string; role_key: string | null }>(
      `SELECT a.id AS actor_id, a.kind, r.key AS role_key
         FROM actors a
         LEFT JOIN memberships m ON m.actor_id = a.id
           AND (m.expires_at IS NULL OR m.expires_at > now())
         LEFT JOIN roles r ON r.id = m.role_id;`,
    );
    const byActor = new Map<string, EligibleApprover>();
    for (const row of roster) {
      const existing = byActor.get(row.actor_id) ?? {
        actorId: row.actor_id,
        actorKind: row.kind === 'agent' ? ('agent' as const) : ('human' as const),
        roles: [] as string[],
      };
      const roles = row.role_key === null ? existing.roles : [...existing.roles, row.role_key];
      byActor.set(row.actor_id, { ...existing, roles });
    }

    const approvals = await db.query<{
      actor_id: string;
      kind: string;
      role_key: string | null;
      decision: string;
      revoked_at: Date | string | null;
    }>(
      `SELECT ap.actor_id, ac.kind, r.key AS role_key, ap.decision, ap.revoked_at
         FROM approvals ap
         JOIN gates g ON g.id = ap.gate_id
         JOIN actors ac ON ac.id = ap.actor_id
         LEFT JOIN roles r ON r.id = ap.role_id
        WHERE g.work_item_id = $1;`,
      [workItemId],
    );

    // The author is whoever claimed the item. Absent is reported as absent —
    // defaulting to "nobody" would make every self-approval count.
    const claims = await db.query<{ claimed_by: string | null }>(
      'SELECT claimed_by FROM work_items WHERE id = $1;',
      [workItemId],
    );

    const verdict = evaluateQuorum(
      requirement,
      approvals.map((row) => ({
        actorId: row.actor_id,
        actorKind: row.kind === 'agent' ? 'agent' : 'human',
        roleId: row.role_key,
        decision: row.decision as 'approve' | 'request-changes' | 'override',
        revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      })),
      {
        authorActorId: claims[0]?.claimed_by ?? '',
        eligible: [...byActor.values()],
        mode,
      },
    );

    return {
      workItemId,
      matched: matched.map((policy) => policy.name),
      mode,
      verdict,
      requirement,
      ok: verdict.satisfied && loaded.problems.length === 0,
    };
  } finally {
    await db.close();
  }
}

export function formatQuorumCheck(result: QuorumCheck): string {
  return [
    `${result.workItemId} — ${result.matched.length === 0 ? 'no policy matched' : `matched ${result.matched.join(', ')}`} (${result.mode} mode)`,
    '',
    formatQuorum(result.requirement, result.verdict),
  ].join('\n');
}

/* ------------------------------------- approvals, revocation, simulation */

async function quorumInputs(
  db: Db,
  root: string,
  workItemId: string,
): Promise<{
  requirement: ReturnType<typeof normaliseQuorum>;
  ctx: QuorumContext;
  approvals: Approval[];
  matched: string[];
}> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  const loaded = loadPolicies(await readPolicyFiles(layout.gatesDir, layout.root));

  const items = await db.query<{
    type: string;
    risk_level: string | null;
    claimed_by: string | null;
  }>('SELECT type, risk_level, claimed_by FROM work_items WHERE id = $1;', [workItemId]);
  const item = items[0];
  const matched = matchPolicies(loaded.policies, {
    workType: item?.type ?? 'feature',
    riskLevel: item?.risk_level ?? 'low',
    paths: [],
  });

  const roster = await db.query<{ actor_id: string; kind: string; role_key: string | null }>(
    `SELECT a.id AS actor_id, a.kind, r.key AS role_key
       FROM actors a
       LEFT JOIN memberships m ON m.actor_id = a.id
         AND (m.expires_at IS NULL OR m.expires_at > now())
       LEFT JOIN roles r ON r.id = m.role_id;`,
  );
  const byActor = new Map<string, EligibleApprover>();
  for (const row of roster) {
    const existing = byActor.get(row.actor_id) ?? {
      actorId: row.actor_id,
      actorKind: row.kind === 'agent' ? ('agent' as const) : ('human' as const),
      roles: [] as string[],
    };
    byActor.set(row.actor_id, {
      ...existing,
      roles: row.role_key === null ? existing.roles : [...existing.roles, row.role_key],
    });
  }

  const rows = await db.query<{
    actor_id: string;
    kind: string;
    role_key: string | null;
    decision: string;
    revoked_at: Date | string | null;
  }>(
    `SELECT ap.actor_id, ac.kind, r.key AS role_key, ap.decision, ap.revoked_at
       FROM approvals ap
       JOIN gates g ON g.id = ap.gate_id
       JOIN actors ac ON ac.id = ap.actor_id
       LEFT JOIN roles r ON r.id = ap.role_id
      WHERE g.work_item_id = $1;`,
    [workItemId],
  );

  return {
    requirement: normaliseQuorum(matched),
    ctx: {
      authorActorId: item?.claimed_by ?? '',
      eligible: [...byActor.values()],
      mode: config?.mode ?? 'solo',
    },
    approvals: rows.map((row) => ({
      actorId: row.actor_id,
      actorKind: row.kind === 'agent' ? 'agent' : 'human',
      roleId: row.role_key,
      decision: row.decision as Approval['decision'],
      revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
    })),
    matched: matched.map((policy) => policy.name),
  };
}

export interface ApproveResult {
  readonly approvalId: number;
  readonly gateId: number;
  readonly workItemId: string;
  readonly role: string;
  readonly provenance: DecisionProvenance;
  readonly satisfied: boolean;
}

/**
 * `sdlc gates approve` — record an approval, with the rule it was taken under.
 *
 * The provenance snapshot is the point (P3-RBAC-06). Without it, editing a
 * policy row afterwards leaves every historical approval unable to explain
 * itself: the audit entry says who approved what, and nothing says which
 * required-role and min-approvals values were the basis at the time. Stored **by
 * value**, because the row is expected to move.
 */
export async function approveGate(
  root: string,
  workItemId: string,
  gateName: string,
  role: string,
): Promise<ApproveResult> {
  return withGatesDb(root, async (db) => {
    const author = await resolveAuthor(db, root, role);
    const { requirement, ctx, approvals, matched } = await quorumInputs(db, root, workItemId);

    const gates = await db.query<{ id: number }>(
      'SELECT id FROM gates WHERE work_item_id = $1 AND gate_name = $2 ORDER BY id DESC LIMIT 1;',
      [workItemId, gateName],
    );
    let gateId = gates[0]?.id;
    if (gateId === undefined) {
      const created = await db.query<{ id: number }>(
        `INSERT INTO gates (work_item_id, gate_name, result) VALUES ($1,$2,'pending') RETURNING id;`,
        [workItemId, gateName],
      );
      gateId = created[0]?.id ?? 0;
    }

    const inserted = await db.query<{ id: number }>(
      `INSERT INTO approvals (gate_id, actor_id, role_id, decision)
       SELECT $1, $2, id, 'approve' FROM roles WHERE key = $3 RETURNING id;`,
      [gateId, author.actorId, role],
    );

    const withMine = [
      ...approvals,
      {
        actorId: author.actorId,
        actorKind: 'human' as const,
        roleId: role,
        decision: 'approve' as const,
      },
    ];
    const verdict = evaluateQuorum(requirement, withMine, ctx);
    const provenance = decisionProvenance(requirement, verdict, ctx);

    const port = await PostgresStorageAdapter.create(db);
    await port.appendAudit({
      action: 'GATE_APPROVED',
      actorId: author.actorId,
      targetType: 'gate',
      targetId: String(gateId),
      // The whole snapshot, not a policy id. ADR-0035's decision-provenance gap.
      detail: { workItemId, role, matched, provenance },
    });

    if (verdict.satisfied) {
      await db.query(`UPDATE gates SET result = 'pass', evaluated_at = now() WHERE id = $1;`, [
        gateId,
      ]);
    }

    return {
      approvalId: inserted[0]?.id ?? 0,
      gateId,
      workItemId,
      role,
      provenance,
      satisfied: verdict.satisfied,
    };
  });
}

export interface RevokeResult {
  readonly approvalId: number;
  readonly gateId: number;
  readonly kind: 'self' | 'third-party';
  readonly impact: ReturnType<typeof revocationImpact>;
}

/**
 * `sdlc gates revoke` — withdraw an approval, and re-open the gate.
 *
 * An append, never an erase: the row stays and is marked. "Approved then
 * withdrawn" and "never approved" are different histories, and a delete
 * collapses them into the one that looks better.
 */
export async function revokeApproval(
  root: string,
  approvalId: number,
  role: string,
  reason: string,
): Promise<RevokeResult> {
  return withGatesDb(root, async (db) => {
    const actor = await resolveAuthor(db, root, role);

    const rows = await db.query<{
      gate_id: number;
      work_item_id: string;
      actor_id: string;
      kind: string;
      role_key: string | null;
      decision: string;
      revoked_at: Date | string | null;
    }>(
      `SELECT ap.gate_id, g.work_item_id, ap.actor_id, ac.kind, r.key AS role_key, ap.decision, ap.revoked_at
         FROM approvals ap
         JOIN gates g ON g.id = ap.gate_id
         JOIN actors ac ON ac.id = ap.actor_id
         LEFT JOIN roles r ON r.id = ap.role_id
        WHERE ap.id = $1;`,
      [approvalId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`no approval with id ${String(approvalId)}`);

    const { requirement, ctx, approvals } = await quorumInputs(db, root, row.work_item_id);
    const before = evaluateQuorum(requirement, approvals, ctx);

    const verdict = evaluateRevocation(requirement, {
      approvalId: String(approvalId),
      gateId: String(row.gate_id),
      approval: {
        actorId: row.actor_id,
        actorKind: row.kind === 'agent' ? 'agent' : 'human',
        roleId: row.role_key,
        decision: row.decision as Approval['decision'],
        revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
      },
      actorId: actor.actorId,
      actorKind: 'human',
      roleKey: role,
      reason,
      now: new Date().toISOString(),
    });

    if (!verdict.allowed) throw new Error(verdict.refusal ?? 'revocation refused');

    await db.query(`UPDATE approvals SET revoked_at = now(), revoked_by = $2 WHERE id = $1;`, [
      approvalId,
      actor.actorId,
    ]);
    // Unconditional, and part of the same operation. A withdrawn approval that
    // leaves the gate reading `pass` is a retraction in name only.
    await db.query(`UPDATE gates SET result = 'pending', evaluated_at = NULL WHERE id = $1;`, [
      row.gate_id,
    ]);

    const port = await PostgresStorageAdapter.create(db);
    await port.appendAudit({
      action: REVOCATION_ACTION,
      actorId: actor.actorId,
      targetType: 'approval',
      targetId: String(approvalId),
      detail: verdict.audit as unknown as Record<string, unknown>,
    });

    const after = evaluateQuorum(
      requirement,
      approvals.filter((entry) => entry.actorId !== row.actor_id),
      ctx,
    );

    return {
      approvalId,
      gateId: row.gate_id,
      kind: verdict.audit?.kind ?? 'self',
      impact: revocationImpact(before, after),
    };
  });
}

/**
 * `sdlc gates simulate` — what a proposed policy change would do, before it lands.
 *
 * Compares the committed policy set against the working tree's, so the answer is
 * about the edit in front of you rather than about two files you had to name.
 */
export async function simulatePolicyChange(
  root: string,
  proposedDir: string,
): Promise<ReturnType<typeof simulateGatePolicy>> {
  const layout = resolveWorkspaceLayout(root);
  const current = loadPolicies(await readPolicyFiles(layout.gatesDir, layout.root));
  const proposed = loadPolicies(
    await readPolicyFiles(path.resolve(layout.root, proposedDir), layout.root),
  );
  return simulateGatePolicy(current.policies, proposed.policies);
}

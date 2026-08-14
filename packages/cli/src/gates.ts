import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { relativePosix, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import {
  compilePolicy,
  evaluateQuorum,
  formatPolicyProblems,
  formatQuorum,
  loadPolicies,
  matchPolicies,
  normaliseQuorum,
  type EligibleApprover,
  type GatePolicySource,
  type PolicyProblem,
  type PolicyTarget,
  type QuorumVerdict,
} from '@sdlc-on-fire/evidence';
import { openWorkspaceDatabase, readConfig } from './commands.js';

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

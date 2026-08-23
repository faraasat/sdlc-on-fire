import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  capability,
  DEFAULT_ROLE_PERMISSIONS,
  formatCapability,
  HUMAN_ONLY_ACTIONS,
  PERMISSION_KEYS,
  ROLE_KEYS,
  roleTableViolations,
  type CapabilityVerdict,
  type RoleKey,
} from '@sdlc-on-fire/core';
import { applySchema, ensureHumanActor, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc access` — who may do what, read out of the database (P3-RBAC-01).
 *
 * ADR-0010 built this on rows rather than a policy library so the rules would be
 * plain, joinable SQL. That only pays off if something actually reads them, so
 * every subcommand here answers from the tables — not from the constants in
 * `core` — and `policy` exists to say when the two have drifted apart.
 *
 * The reason drift matters more than it sounds: `capability()` decides from a
 * policy handed to it, and the daemon hands it whatever the database holds. A
 * permission that is in the constant and missing from the table passes every
 * unit test and refuses every real user, and nothing on either side looks wrong.
 */

const exec = promisify(execFile);

interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function withDb<T>(root: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    // Applied here, not assumed. `sdlc init` provisions the schema, but it is
    // allowed to fail without failing the init — the scaffold on disk is still
    // valid — so a workspace can reach this command with an empty database, and
    // "relation actors does not exist" is not an answer to "who am I".
    // Idempotent, and it is what re-seeds the policy rows.
    await applySchema(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** The policy as the database holds it: `role key → action keys`, sorted. */
async function policyFromDb(db: Db): Promise<Record<string, string[]>> {
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

export interface PolicyResult {
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly table: Readonly<Record<string, readonly string[]>>;
  readonly humanOnly: readonly string[];
  /** Where the rows and `DEFAULT_ROLE_PERMISSIONS` disagree. */
  readonly drift: readonly string[];
  readonly violations: readonly string[];
  readonly ok: boolean;
}

export async function showPolicy(root: string): Promise<PolicyResult> {
  return withDb(root, async (db) => {
    const roles = (await db.query<{ key: string }>('SELECT key FROM roles ORDER BY key;')).map(
      (row) => row.key,
    );
    const permissions = (
      await db.query<{ key: string }>('SELECT key FROM permissions ORDER BY key;')
    ).map((row) => row.key);
    const table = await policyFromDb(db);

    // Both directions. A row the constant does not have is a privilege nobody
    // reviewed; a constant the rows do not have is a permission that works in
    // the tests and not in the product.
    const drift: string[] = [];
    for (const role of new Set([...Object.keys(table), ...Object.keys(DEFAULT_ROLE_PERMISSIONS)])) {
      const inDb = new Set(table[role] ?? []);
      const declared = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role as RoleKey] ?? []);
      for (const key of declared) {
        if (!inDb.has(key)) drift.push(`${role}: "${key}" is declared in core but not in the rows`);
      }
      for (const key of inDb) {
        if (!declared.has(key)) drift.push(`${role}: "${key}" is granted by a row nobody declared`);
      }
    }

    const violations = [...roleTableViolations(roles)];

    // The invariant, asked of the rows rather than assumed from the trigger
    // (P3-RBAC-04). The trigger stops new ones; a database restored from before
    // it existed can still hold one, and an agent carrying a role appears in
    // every roster query as somebody who could approve.
    const agentsWithRoles = await db.query<{ display_name: string; key: string }>(
      `SELECT a.display_name, r.key FROM memberships m
         JOIN actors a ON a.id = m.actor_id
         JOIN roles r ON r.id = m.role_id
        WHERE a.kind = 'agent';`,
    );
    for (const row of agentsWithRoles) {
      violations.push(
        `agent "${row.display_name}" holds role "${row.key}" — the schema never grants agents ` +
          'role-level permissions (ADR-0010), and this row predates the trigger that refuses it',
      );
    }

    return {
      roles,
      permissions,
      table,
      humanOnly: HUMAN_ONLY_ACTIONS,
      drift: drift.sort(),
      violations,
      ok: drift.length === 0 && violations.length === 0,
    };
  });
}

export function formatPolicy(result: PolicyResult): string {
  const lines = [
    `${String(result.roles.length)} role(s), ${String(result.permissions.length)} action(s) — read from the database`,
    '',
  ];

  for (const role of result.roles) {
    const granted = result.table[role] ?? [];
    lines.push(`  ${role.padEnd(12)} ${granted.length === 0 ? '(nothing)' : granted.join(', ')}`);
  }

  lines.push(
    '',
    `Human-only: ${result.humanOnly.join(', ')} — an agent holding the role still cannot.`,
  );

  if (result.violations.length > 0) lines.push('');
  for (const violation of result.violations) lines.push(`  ✗ ${violation}`);

  if (result.drift.length > 0) {
    lines.push('', 'The rows and the code disagree:');
    for (const entry of result.drift) lines.push(`  ✗ ${entry}`);
    lines.push(
      '',
      'This is the failure that looks like nothing: capability() decides from what',
      'the database holds, so a permission only the code knows about passes its',
      'unit test and refuses every real user. `sdlc db:rebuild` re-seeds.',
    );
  }

  return lines.join('\n');
}

export interface ActorRow {
  readonly id: string;
  readonly kind: 'human' | 'agent';
  readonly displayName: string;
  readonly roles: readonly { readonly key: string; readonly expiresAt: string | null }[];
}

/** Resolves an actor by id, email, or display name. */
async function findActor(db: Db, reference: string): Promise<ActorRow | null> {
  const rows = await db.query<{
    id: string;
    kind: string;
    display_name: string;
  }>(
    `SELECT id, kind, display_name FROM actors
      WHERE display_name = $1 OR email = $1 OR id::text = $1
      ORDER BY created_at LIMIT 1;`,
    [reference],
  );
  const actor = rows[0];
  if (actor === undefined) return null;

  const memberships = await db.query<{ key: string; expires_at: Date | string | null }>(
    `SELECT r.key, m.expires_at FROM memberships m
       JOIN roles r ON r.id = m.role_id WHERE m.actor_id = $1 ORDER BY r.key;`,
    [actor.id],
  );

  return {
    id: actor.id,
    kind: actor.kind === 'agent' ? 'agent' : 'human',
    displayName: actor.display_name,
    roles: memberships.map((row) => ({
      key: row.key,
      expiresAt: row.expires_at === null ? null : new Date(String(row.expires_at)).toISOString(),
    })),
  };
}

export interface WhoamiResult {
  readonly actor: ActorRow;
  /** True when this run created the row rather than finding it. */
  readonly created: boolean;
  readonly source: string;
}

/**
 * `sdlc access whoami` — the human actor for this workspace, created if needed.
 *
 * Bootstrapped from `git config user.email`, per contract 01 §3.3. Nothing else
 * in the workspace knows who you are, and inventing an identity out of `$USER`
 * would produce a different actor on every machine the same person works from.
 */
export async function whoami(root: string): Promise<WhoamiResult> {
  const email = await exec('git', ['config', 'user.email'], { cwd: root })
    .then((result) => result.stdout.trim())
    .catch(() => '');
  const name = await exec('git', ['config', 'user.name'], { cwd: root })
    .then((result) => result.stdout.trim())
    .catch(() => '');

  if (email === '') {
    throw new Error(
      'git config user.email is not set — that is where a human actor comes from ' +
        '(contract 01 §3.3), and guessing one would mint a different identity on every machine',
    );
  }

  return withDb(root, async (db) => {
    // Shared with `sdlc init` and `sdlc serve` rather than inlined here. This
    // function grew its own INSERT first, and once `init` also needed to
    // bootstrap — the UI resolves identity without ever running `whoami` — two
    // implementations of "make sure this human exists" would have had to agree
    // forever about matching, casing and the display-name fallback.
    const outcome = await ensureHumanActor(db, email, name);
    const actor = await findActor(db, email);
    if (actor === null) throw new Error('actor was inserted but could not be read back');
    return { actor, created: outcome.created, source: `git config user.email (${email})` };
  });
}

export interface GrantResult {
  readonly actor: ActorRow;
  readonly role: string;
  readonly expiresAt: string | null;
  readonly alreadyHeld: boolean;
}

/**
 * `sdlc access grant` — give an actor a role, optionally until a date.
 *
 * `--until` is the ADR-0035 amendment made reachable. A grant handed out for one
 * release and never revoked is the ordinary way a permission model rots, and the
 * fix is not vigilance — it is an end date at the moment of granting, when
 * somebody actually knows what it should be.
 */
export async function grantRole(
  root: string,
  reference: string,
  role: string,
  until?: string,
): Promise<GrantResult> {
  if (!(ROLE_KEYS as readonly string[]).includes(role)) {
    throw new Error(
      `unknown role "${role}" — the model is capped at ${ROLE_KEYS.join(', ')} (ADR-0010), ` +
        'and a new one is a modeling decision rather than a row',
    );
  }
  if (until !== undefined && Number.isNaN(Date.parse(until))) {
    throw new Error(`--until "${until}" is not a date this can read, so it would never expire`);
  }

  return withDb(root, async (db) => {
    const actor = await findActor(db, reference);
    if (actor === null)
      throw new Error(`no actor matches "${reference}" — try \`sdlc access whoami\``);

    // Refused here as well as by the trigger (P3-RBAC-04), so the message
    // explains the model rather than surfacing a raise from plpgsql.
    if (actor.kind === 'agent') {
      throw new Error(
        `${actor.displayName} is an agent, and the schema never grants agents role-level ` +
          "permissions (ADR-0010) — an agent's capability comes from its relationship to a card, " +
          'being its assignee, never from a role',
      );
    }

    const alreadyHeld = actor.roles.some((held) => held.key === role);
    await db.query(
      `INSERT INTO memberships (actor_id, role_id, expires_at)
       SELECT $1, id, $3::timestamptz FROM roles WHERE key = $2
       ON CONFLICT (actor_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at;`,
      [actor.id, role, until ?? null],
    );

    const after = await findActor(db, reference);
    return {
      actor: after ?? actor,
      role,
      expiresAt: until === undefined ? null : new Date(until).toISOString(),
      alreadyHeld,
    };
  });
}

export interface CheckResult {
  readonly actor: ActorRow;
  readonly action: string;
  readonly cardId: string;
  readonly verdict: CapabilityVerdict;
  readonly ok: boolean;
}

/**
 * `sdlc access check` — would this actor be allowed, and on what grounds.
 *
 * Every input comes from the database: the actor, their memberships and their
 * expiry dates, the policy table, and any gate currently blocking the card. The
 * answer carries its ground rather than a bare yes/no, because "the eng lead has
 * this permission" and "nobody has said otherwise" are different answers and
 * only one of them is worth acting on.
 */
export async function checkAccess(
  root: string,
  reference: string,
  action: string,
  cardId: string,
  now = new Date().toISOString(),
): Promise<CheckResult> {
  if (!(PERMISSION_KEYS as readonly string[]).includes(action)) {
    throw new Error(`unknown action "${action}" — known actions: ${PERMISSION_KEYS.join(', ')}`);
  }

  return withDb(root, async (db) => {
    const actor = await findActor(db, reference);
    if (actor === null)
      throw new Error(`no actor matches "${reference}" — try \`sdlc access whoami\``);

    const gates = await db.query<{ gate_name: string }>(
      `SELECT gate_name FROM gates WHERE work_item_id = $1 AND result IS DISTINCT FROM 'pass';`,
      [cardId],
    );

    const verdict = capability({
      actor: { id: actor.id, kind: actor.kind, displayName: actor.displayName },
      action,
      cardId,
      memberships: actor.roles.map((held) => ({
        actorId: actor.id,
        roleKey: held.key,
        expiresAt: held.expiresAt ?? undefined,
      })),
      rolePermissions: await policyFromDb(db),
      // A gate that has not passed blocks the whole card. Narrowing this to
      // specific actions belongs with gate policies (P3-RBAC-03), and guessing
      // at it here would let a gate look narrower than it is.
      blockingGates: gates.map((gate) => ({ cardId, gate: gate.gate_name, blocks: [] })),
      humanOnlyActions: HUMAN_ONLY_ACTIONS,
      now,
    });

    return { actor, action, cardId, verdict, ok: verdict.granted };
  });
}

export function formatAccessCheck(result: CheckResult): string {
  return formatCapability(
    {
      actor: {
        id: result.actor.id,
        kind: result.actor.kind,
        displayName: result.actor.displayName,
      },
      action: result.action,
      cardId: result.cardId,
      memberships: [],
      rolePermissions: {},
      now: '',
    },
    result.verdict,
  );
}

export interface ResolvedAuthor {
  readonly actorId: string;
  readonly roleKey: string;
}

/**
 * The actor behind a claimed role, or a refusal (P3-RBAC-02).
 *
 * `sdlc comment --role security` decides what the comment *does*, so taking the
 * flag at face value would let anybody who can post a comment grant themselves
 * a gate block. The role has to be one this actor actually holds, and holds
 * now — an expired membership is refused with the reason, because "you never
 * had this" would send somebody to the wrong place.
 */
export async function resolveAuthor(
  db: Db,
  root: string,
  role: string,
  now = new Date().toISOString(),
): Promise<ResolvedAuthor> {
  const email = await exec('git', ['config', 'user.email'], { cwd: root })
    .then((result) => result.stdout.trim())
    .catch(() => '');

  const actor = email === '' ? null : await findActor(db, email);
  if (actor === null) {
    throw new Error(
      `--role ${role} needs an actor to hold it, and this workspace has none for ` +
        `${email === '' ? 'you (git config user.email is unset)' : email} — ` +
        'run `sdlc access whoami`, then `sdlc access grant`',
    );
  }

  const held = actor.roles.find((entry) => entry.key === role);
  if (held === undefined) {
    throw new Error(
      `${actor.displayName} does not hold "${role}" — the comment's effect is computed from the ` +
        'role, so a self-asserted role would be a self-granted effect (ADR-0012). ' +
        `\`sdlc access grant ${email} ${role}\` if that is the intent`,
    );
  }
  if (held.expiresAt !== null && !(Date.parse(held.expiresAt) > Date.parse(now))) {
    throw new Error(
      `${actor.displayName}'s "${role}" membership expired ${held.expiresAt} — a lapsed grant is ` +
        'not a grant (ADR-0035)',
    );
  }

  return { actorId: actor.id, roleKey: role };
}

/* ------------------------------------------------------- expiring grants */

export const GRANT_EXPIRED_ACTION = 'MEMBERSHIP_EXPIRED';

export interface GrantRow {
  readonly actorId: string;
  readonly displayName: string;
  readonly roleKey: string;
  readonly expiresAt: string | null;
  /** `live` | `expiring` (inside the window) | `lapsed`. */
  readonly state: 'live' | 'expiring' | 'lapsed';
}

export interface GrantsResult {
  readonly grants: readonly GrantRow[];
  /** Lapses this run recorded in the audit log for the first time. */
  readonly recorded: readonly string[];
  /** Roles that no live human grant covers any more. */
  readonly uncovered: readonly string[];
  readonly windowDays: number;
}

/**
 * `sdlc access grants` — every membership, when it lapses, and what that costs.
 *
 * ADR-0035 added `expires_at` so a grant handed out for one release does not
 * become permanent, and `capability()` reads the date at evaluation time — so
 * the revert is automatic by construction, with no sweep to forget to run.
 *
 * What automatic does **not** give you is a record or a warning, and both
 * matter here. ADR-0035's stated motivation is the *inactive-approver deadlock*:
 * the last holder of a required role goes quiet, their grant lapses, and the
 * first anybody hears of it is a gate that will not open. So this does three
 * things a bare column cannot:
 *
 * **Records the lapse, once.** A grant that expires by clock produces no event;
 * this writes `MEMBERSHIP_EXPIRED` into the append-only audit log the first time
 * anybody looks, keyed so a second look does not write a second row. "It just
 * stopped working" is not an audit trail.
 *
 * **Warns before, not after.** A grant inside the window is `expiring`, which
 * is the only state a person can still act on.
 *
 * **Names the roles about to lose their last holder** — the deadlock itself,
 * rather than the row that causes it.
 */
export async function listGrants(
  root: string,
  windowDays = 14,
  now = new Date(),
): Promise<GrantsResult> {
  return withDb(root, async (db) => {
    const rows = await db.query<{
      actor_id: string;
      display_name: string;
      kind: string;
      role_key: string;
      expires_at: Date | string | null;
    }>(
      `SELECT m.actor_id, a.display_name, a.kind, r.key AS role_key, m.expires_at
         FROM memberships m
         JOIN actors a ON a.id = m.actor_id
         JOIN roles r ON r.id = m.role_id
        ORDER BY a.display_name, r.key;`,
    );

    const horizon = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const grants: GrantRow[] = rows.map((row) => {
      const expiresAt = row.expires_at === null ? null : new Date(String(row.expires_at));
      const state: GrantRow['state'] =
        expiresAt === null
          ? 'live'
          : expiresAt <= now
            ? 'lapsed'
            : expiresAt <= horizon
              ? 'expiring'
              : 'live';
      return {
        actorId: row.actor_id,
        displayName: row.display_name,
        roleKey: row.role_key,
        expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
        state,
      };
    });

    // Recorded once. The key is (actor, role, expiry) rather than (actor, role)
    // so a re-granted-and-lapsed-again membership is a second event, which it is.
    const recorded: string[] = [];
    for (const grant of grants.filter((entry) => entry.state === 'lapsed')) {
      const key = `${grant.actorId}:${grant.roleKey}:${grant.expiresAt ?? ''}`;
      const already = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM audit_log
          WHERE action = $1 AND target_type = 'membership' AND target_id = $2;`,
        [GRANT_EXPIRED_ACTION, key],
      );
      if ((already[0]?.count ?? 0) > 0) continue;

      const port = await PostgresStorageAdapter.create(db);
      await port.appendAudit({
        action: GRANT_EXPIRED_ACTION,
        actorId: grant.actorId,
        targetType: 'membership',
        targetId: key,
        detail: {
          role: grant.roleKey,
          expiredAt: grant.expiresAt,
          note: 'grant lapsed on its own (ADR-0035); recorded the first time anybody looked',
        },
      });
      recorded.push(key);
    }

    // A role whose last *live* holder is gone. This is the deadlock ADR-0035
    // names, stated as the thing that breaks rather than the row that expired.
    const live = new Set(
      grants.filter((grant) => grant.state !== 'lapsed').map((grant) => grant.roleKey),
    );
    const uncovered = [
      ...new Set(
        grants
          .filter((grant) => grant.state === 'lapsed' && !live.has(grant.roleKey))
          .map((g) => g.roleKey),
      ),
    ].sort();

    return { grants, recorded, uncovered, windowDays };
  });
}

export function formatGrants(result: GrantsResult): string {
  const lines = [`${String(result.grants.length)} grant(s)`, ''];

  for (const grant of result.grants) {
    const when =
      grant.expiresAt === null
        ? 'indefinite'
        : `${grant.state === 'lapsed' ? 'lapsed' : 'until'} ${grant.expiresAt}`;
    const mark = grant.state === 'lapsed' ? '✗' : grant.state === 'expiring' ? '!' : '•';
    lines.push(`  ${mark} ${grant.displayName.padEnd(16)} ${grant.roleKey.padEnd(12)} ${when}`);
  }
  if (result.grants.length === 0) lines.push('  none — `sdlc access grant` gives one');

  if (result.recorded.length > 0) {
    lines.push(
      '',
      `${String(result.recorded.length)} lapse(s) recorded in the audit log just now.`,
      'A grant that expires by clock produces no event of its own, and "it just',
      'stopped working" is not an audit trail.',
    );
  }

  if (result.uncovered.length > 0) {
    lines.push(
      '',
      `No live holder for: ${result.uncovered.join(', ')}.`,
      'This is the deadlock ADR-0035 is about: a gate requiring one of these',
      'cannot open, and nothing else would have said so until somebody tried.',
    );
  }

  return lines.join('\n');
}

/**
 * Bootstrapping the human (P3-UI-01).
 *
 * The `actors` table has always carried the comment "Humans: bootstrapped from
 * git config user.email", and nothing bootstrapped one. That was invisible from
 * the CLI, where an agent is launched with its actor, and became visible the
 * moment a browser asked "who am I": identity resolved to `none` on a
 * freshly-initialised workspace, so solo mode — the fallback that exists
 * precisely so a lone developer never has to configure anything — could never
 * trigger. Found by running `sdlc serve` against a real scaffold, not by a test.
 */

export interface ActorWriter {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface EnsureHumanActorResult {
  readonly actorId: string | null;
  readonly created: boolean;
  readonly because: string;
}

/**
 * Ensure a human actor exists for this email. Idempotent.
 *
 * Matching is on the email, lower-cased, because `git config user.email` is
 * what a person changes casing on without meaning anything by it — and two
 * actor rows for one person would make identity resolution ambiguous and
 * therefore refuse, which is a worse outcome than either row alone.
 */
export async function ensureHumanActor(
  db: ActorWriter,
  email: string | undefined,
  displayName?: string,
): Promise<EnsureHumanActorResult> {
  const normalised = (email ?? '').trim().toLowerCase();
  if (normalised === '') {
    return {
      actorId: null,
      created: false,
      because: 'no git user.email is configured, so there is nobody to bootstrap',
    };
  }

  const existing = await db.query<{ id: string; display_name: string }>(
    `SELECT id::text AS id, display_name FROM actors
      WHERE kind = 'human' AND lower(email) = $1 LIMIT 1;`,
    [normalised],
  );
  const first = existing[0];
  if (first !== undefined) {
    // Upgrade a placeholder name. `init` runs before `git config user.name` is
    // necessarily set, and falls back to the email; a later call that *does*
    // know the name should improve the row rather than leave the person
    // labelled by their email address forever. Only ever replaces the
    // placeholder — a real name already recorded is never overwritten.
    const better = displayName?.trim() ?? '';
    if (better !== '' && better.toLowerCase() !== normalised && first.display_name === normalised) {
      await db.query(`UPDATE actors SET display_name = $1 WHERE id = $2;`, [better, first.id]);
      return { actorId: first.id, created: false, because: `named this human ${better}` };
    }
    return { actorId: first.id, created: false, because: 'this human is already known' };
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO actors (kind, display_name, email) VALUES ('human', $1, $2) RETURNING id::text AS id;`,
    [
      displayName?.trim() === '' || displayName === undefined ? normalised : displayName.trim(),
      normalised,
    ],
  );
  const row = inserted[0];
  return {
    actorId: row?.id ?? null,
    created: true,
    because: `bootstrapped a human actor from git user.email (${normalised})`,
  };
}

/**
 * Agent teammates, one persistent row each (P3-RBAC-09).
 *
 * Agents were transient: a run named its agent in a string and no `actors` row
 * existed for it. That is fine while nothing needs to *refer* to an agent, and
 * it breaks the moment one does — presence on a board, a memory row scoped to a
 * writer, an assignment. Those all need an id, and inventing one per run means
 * "what has this agent been doing" has no answer.
 *
 * Idempotent on `agent_target`, and deliberately not on display name: a target
 * is what the daemon launches, and two rows for one target would split a
 * teammate's history in half.
 */
export async function ensureAgentActor(
  db: ActorWriter,
  agentTarget: string,
  displayName?: string,
): Promise<EnsureHumanActorResult> {
  const target = agentTarget.trim();
  if (target === '') {
    return { actorId: null, created: false, because: 'no agent target given' };
  }

  const existing = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM actors WHERE kind = 'agent' AND agent_target = $1 LIMIT 1;`,
    [target],
  );
  const first = existing[0];
  if (first !== undefined) {
    return { actorId: first.id, created: false, because: `${target} is already a known teammate` };
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO actors (kind, display_name, agent_target)
     VALUES ('agent', $1, $2) RETURNING id::text AS id;`,
    [displayName?.trim() === '' || displayName === undefined ? target : displayName.trim(), target],
  );
  return {
    actorId: inserted[0]?.id ?? null,
    created: true,
    because: `registered ${target} as an agent teammate`,
  };
}

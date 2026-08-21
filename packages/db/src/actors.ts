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

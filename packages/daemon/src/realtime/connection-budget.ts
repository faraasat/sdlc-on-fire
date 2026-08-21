/**
 * Connection budget (P3-META-01).
 *
 * The team topology is one daemon per developer against a shared Postgres, and
 * the thing that breaks first is not CPU or disk — it is `max_connections`.
 *
 * The reason is specific to how realtime works here. `LISTEN` is not a query;
 * it is a session that stays open for as long as the daemon runs, so it cannot
 * share a pool with request traffic. Each daemon therefore holds **one
 * dedicated connection that is never returned**, plus whatever its pool uses.
 * That is fine for three developers and is a wall at thirty, and the failure
 * mode is the worst kind: the next person to start a daemon gets "too many
 * clients already" and has no way to know it is a shared budget rather than a
 * broken install.
 *
 * So the budget is computed, reported, and refused *before* connecting rather
 * than discovered by the developer who happened to be last.
 */

/** Postgres' own default. Overridden by asking the server, never assumed. */
export const DEFAULT_MAX_CONNECTIONS = 100;

/**
 * Connections Postgres keeps for itself.
 *
 * `superuser_reserved_connections` defaults to 3. They are not available to
 * ordinary clients, so counting them as headroom would put the wall three
 * connections earlier than the number suggests — and the last developer would
 * be refused while the dashboard still showed capacity.
 */
export const RESERVED_CONNECTIONS = 3;

export interface DaemonFootprint {
  /** The dedicated LISTEN session. Always exactly one, never pooled. */
  readonly listen: number;
  /** Query-pool connections this daemon may open. */
  readonly poolMax: number;
}

export const DEFAULT_FOOTPRINT: DaemonFootprint = { listen: 1, poolMax: 4 };

export function connectionsPerDaemon(footprint: DaemonFootprint = DEFAULT_FOOTPRINT): number {
  return footprint.listen + footprint.poolMax;
}

export interface BudgetVerdict {
  readonly maxConnections: number;
  readonly usable: number;
  readonly perDaemon: number;
  /** How many daemons the server can actually carry. */
  readonly capacity: number;
  readonly current: number;
  readonly admitted: boolean;
  readonly because: string;
}

/**
 * Whether one more daemon fits.
 *
 * Refuses at the point the *next* daemon would exceed the budget, not at the
 * point the server errors. The difference matters: an error from Postgres
 * arrives as "too many clients already", which reads like a misconfiguration to
 * whoever hits it and says nothing about a budget shared with their colleagues.
 */
export function admitDaemon(input: {
  readonly maxConnections?: number;
  readonly currentDaemons: number;
  readonly footprint?: DaemonFootprint;
}): BudgetVerdict {
  const maxConnections = input.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const perDaemon = connectionsPerDaemon(input.footprint);
  const usable = Math.max(0, maxConnections - RESERVED_CONNECTIONS);
  const capacity = perDaemon <= 0 ? 0 : Math.floor(usable / perDaemon);
  const current = Math.max(0, input.currentDaemons);

  if (current >= capacity) {
    return {
      maxConnections,
      usable,
      perDaemon,
      capacity,
      current,
      admitted: false,
      because:
        `this Postgres carries ${String(capacity)} daemon(s) at ${String(perDaemon)} connections each ` +
        `(${String(maxConnections)} max, ${String(RESERVED_CONNECTIONS)} reserved for superusers), and ` +
        `${String(current)} are already running. Raise max_connections, use a pooler, or stop a daemon`,
    };
  }

  return {
    maxConnections,
    usable,
    perDaemon,
    capacity,
    current,
    admitted: true,
    because: `${String(capacity - current)} more daemon(s) fit within this server's budget`,
  };
}

/**
 * Read the server's real limit.
 *
 * Asked, never assumed: `max_connections` is routinely raised in production and
 * lowered on small managed instances, and a budget computed from a guessed 100
 * is a budget that is wrong in both directions.
 */
export async function readMaxConnections(db: {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}): Promise<number | null> {
  try {
    const rows = await db.query<{ setting: string }>(`SHOW max_connections;`);
    const raw = rows[0]?.setting;
    const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // PGlite has no such setting, and single-process embedded mode has no
    // shared budget to exceed. Null means "not applicable", never zero.
    return null;
  }
}

/** How many daemons are currently connected, counted from Postgres itself. */
export async function countDaemonConnections(
  db: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> },
  applicationName = 'sdlc-on-fire-daemon',
): Promise<number | null> {
  try {
    const rows = await db.query<{ count: string }>(
      `SELECT count(DISTINCT client_addr || ':' || pid)::text AS count
         FROM pg_stat_activity WHERE application_name = $1;`,
      [applicationName],
    );
    const value = Number.parseInt(rows[0]?.count ?? '', 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function formatBudget(verdict: BudgetVerdict): string {
  return [
    `Connection budget: ${String(verdict.current)}/${String(verdict.capacity)} daemon(s)`,
    `  max_connections     ${String(verdict.maxConnections)}`,
    `  reserved            ${String(RESERVED_CONNECTIONS)} (superuser)`,
    `  usable              ${String(verdict.usable)}`,
    `  per daemon          ${String(verdict.perDaemon)} (1 dedicated LISTEN + pool)`,
    '',
    verdict.because,
  ].join('\n');
}

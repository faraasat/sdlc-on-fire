import {
  classifyConfigDrift,
  isDowngrade,
  type ConfigDrift,
  type GateStrengthConfig,
} from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { openWorkspaceDatabase, readConfig } from './commands.js';

/**
 * Recording that the gates got weaker (P8-BAR-03).
 *
 * The signal `metrics.md` §3a calls *"the clearest abandonment leading
 * indicator"* — somebody dropping `standard`→`lite`, or switching a control
 * off. It had no writer because `.sdlcof/config.yaml` is a file a person edits
 * in an editor and `sdlc config` only ever read it back.
 *
 * **This is a sampler, not a change feed, and the naming says so.** A snapshot
 * is taken when a command that reads the config happens to run, so what is
 * stored is when the drift was *observed*. Two edits between observations
 * collapse into one row. That limit is stated rather than hidden because the
 * plausible fix — reading the file's mtime — produces a precise-looking
 * timestamp that a checkout, a format-on-save or a `git stash` makes wrong.
 *
 * **Nothing is written when nothing moved.** A row per invocation would bury
 * five real downgrades a year under a table of noise, and the absence of a row
 * is what "unchanged" means here.
 */

interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function withDb<T>(root: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** The five settings that decide how much the harness may stop you. */
export async function readGateStrength(root: string): Promise<GateStrengthConfig | null> {
  const config = await readConfig(root);
  if (config === null) return null;
  return {
    preset: config.preset,
    mode: config.mode,
    sandboxTier: config.sandbox.tier,
    sandboxRequired: config.sandbox.required,
    autoApproveUnambiguous: config.intake.autoApproveUnambiguous,
  };
}

export interface ConfigEventResult {
  readonly recorded: boolean;
  readonly first: boolean;
  readonly drift: ConfigDrift | null;
  readonly downgrade: boolean;
  readonly snapshot: GateStrengthConfig | null;
  readonly because: string;
}

/**
 * Compares the config now against the last snapshot and records any drift.
 *
 * The **first** observation is deliberately not an event. A workspace's initial
 * config did not move from anything, and recording it as a change would make
 * every new install report a config event on day one — which is precisely the
 * noise that makes an abandonment indicator unreadable. The baseline is still
 * stored, so the *second* observation has something to compare against.
 */
export async function recordConfigSnapshot(
  root: string,
  options: { readonly observedAt?: string | undefined } = {},
): Promise<ConfigEventResult> {
  const snapshot = await readGateStrength(root);
  if (snapshot === null) {
    return {
      recorded: false,
      first: false,
      drift: null,
      downgrade: false,
      snapshot: null,
      because: 'no workspace config to read — run `sdlc init` first',
    };
  }

  return withDb(root, async (db) => {
    const rows = await db.query<{ snapshot: unknown }>(
      'SELECT snapshot FROM config_events ORDER BY id DESC LIMIT 1;',
    );
    const raw = rows[0]?.snapshot;
    const previous =
      raw === undefined || raw === null
        ? null
        : ((typeof raw === 'string' ? JSON.parse(raw) : raw) as GateStrengthConfig);

    const observedAt = options.observedAt ?? new Date().toISOString();

    if (previous === null) {
      // The baseline. Stored as `strengthened` with an empty change list so the
      // CHECK constraint holds without inventing an `unchanged` direction that
      // every later query would have to filter out.
      await db.query(
        `INSERT INTO config_events (observed_at, direction, changes, snapshot)
         VALUES ($1::timestamptz, 'strengthened', '[]'::jsonb, $2::jsonb);`,
        [observedAt, JSON.stringify(snapshot)],
      );
      return {
        recorded: true,
        first: true,
        drift: null,
        downgrade: false,
        snapshot,
        because: 'first reading — recorded as the baseline, not as a change',
      };
    }

    const drift = classifyConfigDrift(previous, snapshot);
    if (drift.direction === 'unchanged') {
      return {
        recorded: false,
        first: false,
        drift,
        downgrade: false,
        snapshot,
        because: drift.because,
      };
    }

    await db.query(
      `INSERT INTO config_events (observed_at, direction, changes, snapshot)
       VALUES ($1::timestamptz, $2, $3::jsonb, $4::jsonb);`,
      [observedAt, drift.direction, JSON.stringify(drift.changes), JSON.stringify(snapshot)],
    );

    return {
      recorded: true,
      first: false,
      drift,
      downgrade: isDowngrade(drift),
      snapshot,
      because: drift.because,
    };
  });
}

export function formatConfigEvent(result: ConfigEventResult): string {
  if (!result.recorded) return result.because;
  if (result.first) return 'baseline recorded — the next reading has something to compare against';
  const lines = [`${result.drift?.direction ?? 'changed'}:`];
  for (const change of result.drift?.changes ?? []) {
    lines.push(`  ${change.field}: ${change.from} → ${change.to} (${change.effect})`);
    lines.push(`    ${change.because}`);
  }
  if (result.downgrade) {
    lines.push('', 'This is the abandonment leading indicator (metrics.md §3a, R-08).');
  }
  return lines.join('\n');
}

export interface ConfigEventRow {
  readonly observedAt: string;
  readonly direction: string;
  readonly changes: readonly { readonly field: string; readonly effect: string }[];
}

export async function readConfigEvents(root: string): Promise<readonly ConfigEventRow[]> {
  return withDb(root, async (db) => {
    const rows = await db.query<{
      observed_at: Date | string;
      direction: string;
      changes: unknown;
    }>('SELECT observed_at, direction, changes FROM config_events ORDER BY id;');
    return rows.map((row) => ({
      observedAt: new Date(row.observed_at).toISOString(),
      direction: row.direction,
      changes: (typeof row.changes === 'string'
        ? JSON.parse(row.changes)
        : (row.changes ?? [])) as readonly { field: string; effect: string }[],
    }));
  });
}

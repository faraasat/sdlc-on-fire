import fs from 'node:fs/promises';
import path from 'node:path';
import {
  diffWatch,
  formatWatchDelta,
  type PackageIntelPort,
  type WatchDelta,
  type WatchRecord,
  type WatchedPackage,
} from '@sdlc-on-fire/core';
import { createOsvIntel } from '@sdlc-on-fire/daemon';
import { installedPackages } from './licenses.js';

/**
 * `sdlc deps watch` (P2-SEC-09, ADR-0033).
 *
 * Polls the advisory database against the versions **actually installed**, and
 * reports what changed since last time.
 *
 * Installed versions, not declared ranges: a compromise attaches to a published
 * version, and `^1.2.0` does not name one. This is also why the record is keyed
 * on `name@version` — the same package at a different version is a different
 * question.
 */

/** Where the snapshot lives. Local state, so it belongs under `.sdlcof/`. */
export const WATCH_RECORD_PATH = path.join('.sdlcof', 'supply-chain', 'watch.json');

export interface WatchResult {
  readonly root: string;
  readonly source: string;
  readonly packagesPolled: number;
  readonly delta: WatchDelta;
  /** Set when the poll could not reach the advisory source. */
  readonly degraded?: string | undefined;
}

export async function readWatchRecord(root: string): Promise<WatchRecord | null> {
  const raw = await fs.readFile(path.join(root, WATCH_RECORD_PATH), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as WatchRecord;
    // A record without packages cannot serve as a comparison point, and
    // treating it as an empty baseline would report the whole tree as new.
    return Array.isArray(parsed.packages) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeWatchRecord(root: string, record: WatchRecord): Promise<void> {
  const file = path.join(root, WATCH_RECORD_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export interface WatchOptions {
  /**
   * Built with the degradation reporter, rather than passed in ready-made.
   *
   * A plain port cannot signal "I could not reach anything" — that channel
   * belongs to the adapter, and a test given only a finished port can neither
   * exercise nor verify the guard that protects the stored record during an
   * outage. Taking a factory makes the outage a real state a test can enter.
   */
  readonly intel?: ((onDegraded: (reason: string) => void) => PackageIntelPort) | undefined;
  /** When true, report the delta and leave the stored record alone. */
  readonly dryRun?: boolean | undefined;
  /** Injected so "now" is deterministic in tests. */
  readonly now?: Date | undefined;
}

export async function watchDependencies(
  root: string,
  options: WatchOptions = {},
): Promise<WatchResult> {
  let degraded: string | undefined;
  const report = (reason: string): void => {
    degraded = reason;
  };
  const intel =
    options.intel === undefined ? createOsvIntel({ onDegraded: report }) : options.intel(report);

  const installed = await installedPackages(root);
  // Keyed on name *and* version, and the version is sent to the advisory
  // source. Without it OSV answers with every advisory the package has ever
  // carried, including ones fixed years ago — which inflates the baseline,
  // buries the one that matters, and means an upgrade that *resolves* an
  // advisory never shows up as resolved.
  const byKey = new Map<string, { name: string; ecosystem: string; version?: string }>();
  for (const pkg of installed) {
    const key = `${pkg.name}@${pkg.version ?? '*'}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: pkg.name,
        ecosystem: 'npm',
        ...(pkg.version === undefined ? {} : { version: pkg.version }),
      });
    }
  }

  const signals = await intel.lookup([...byKey.values()]);
  const current: WatchedPackage[] = signals.map((signal) => ({
    name: signal.name,
    ...(signal.version === undefined ? {} : { version: signal.version }),
    advisories: [...signal.advisories],
  }));

  const previous = await readWatchRecord(root);
  const delta = diffWatch(previous, current);

  // A degraded poll must never overwrite a good record. Doing so would erase
  // the advisories we knew about, and the *next* poll would then report every
  // one of them as newly discovered — an outage manufacturing a false alarm,
  // which is the fastest way to make people ignore real ones.
  if (options.dryRun !== true && degraded === undefined) {
    await writeWatchRecord(root, {
      polledAt: (options.now ?? new Date()).toISOString(),
      source: intel.id,
      packages: current,
    });
  }

  return {
    root,
    source: intel.id,
    packagesPolled: current.length,
    delta,
    ...(degraded === undefined ? {} : { degraded }),
  };
}

export function formatWatch(result: WatchResult): string {
  const lines = [formatWatchDelta(result.delta, result.source)];
  if (result.degraded !== undefined) {
    lines.push(
      '',
      `The poll did not reach the advisory source (${result.degraded}), so this is not a`,
      'clean result — it is no result. The stored record was left untouched rather than',
      'overwritten with nothing.',
    );
  }
  return lines.join('\n');
}

/**
 * The write-back-loop guard.
 *
 * The daemon both writes managed Markdown and watches it, so its own writes come
 * back as watcher events. Hash equality alone is *not* a sufficient guard —
 * `.research/03` §"Concurrent-writer loop-safety" flags two real races it misses:
 *
 *   1. A legitimate external edit that happens to produce a byte-identical file
 *      would be dropped as "already known".
 *   2. An external edit landing between the daemon's disk write and its DB write
 *      would be skipped, because the watcher would compare against a stale row.
 *
 * So a self-write is recorded *explicitly* — keyed on path **and** hash, with a
 * TTL — rather than inferred. Anything not in the registry is treated as
 * external and re-processed, which is the safe direction to be wrong in:
 * re-processing an unchanged file is a wasted upsert, dropping a real edit is
 * silent data loss.
 */

/** How long a recorded self-write stays claimable. */
export const DEFAULT_SELF_WRITE_TTL_MS = 5_000;

interface Entry {
  readonly hash: string;
  readonly expiresAt: number;
}

export interface SelfWriteRegistryOptions {
  readonly ttlMs?: number | undefined;
  /** Injectable clock — tests must not depend on wall time. */
  readonly now?: (() => number) | undefined;
}

export class SelfWriteRegistry {
  readonly #entries = new Map<string, Entry[]>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options?: SelfWriteRegistryOptions) {
    this.#ttlMs = options?.ttlMs ?? DEFAULT_SELF_WRITE_TTL_MS;
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Records that the daemon is about to write `hash` to `path`.
   *
   * Call this **before** the disk write completes. Recording afterwards leaves a
   * window in which the watcher event arrives first and the write is treated as
   * external — the exact ordering bug this class exists to close.
   */
  record(path: string, hash: string): void {
    const existing = this.#live(path);
    existing.push({ hash, expiresAt: this.#now() + this.#ttlMs });
    this.#entries.set(path, existing);
  }

  /**
   * Whether this (path, hash) was a recorded self-write — and consumes it.
   *
   * Consuming matters: a second event carrying the same hash is a genuine
   * external rewrite, not the same write echoing twice, and must not be
   * swallowed by a stale claim.
   */
  claim(path: string, hash: string): boolean {
    const live = this.#live(path);
    const index = live.findIndex((entry) => entry.hash === hash);
    if (index === -1) {
      this.#store(path, live);
      return false;
    }
    live.splice(index, 1);
    this.#store(path, live);
    return true;
  }

  /** Number of unexpired claims outstanding. Diagnostics only. */
  get size(): number {
    let total = 0;
    for (const path of [...this.#entries.keys()]) total += this.#live(path).length;
    return total;
  }

  /** Drops every claim — used when the watcher restarts and prior claims are moot. */
  clear(): void {
    this.#entries.clear();
  }

  #live(path: string): Entry[] {
    const now = this.#now();
    return (this.#entries.get(path) ?? []).filter((entry) => entry.expiresAt > now);
  }

  #store(path: string, entries: Entry[]): void {
    if (entries.length === 0) this.#entries.delete(path);
    else this.#entries.set(path, entries);
  }
}

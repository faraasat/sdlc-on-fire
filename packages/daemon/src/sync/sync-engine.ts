import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  contentHash,
  isManagedContentPath,
  type MirrorTable,
  type StoragePort,
} from '@sdlc-on-fire/core';
import { chunkFile, indexableText } from '@sdlc-on-fire/context';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { SelfWriteRegistry } from './self-write-registry.js';

/**
 * The Markdown → DB mirror (`.research/03`).
 *
 * Direction is one-way and non-negotiable (architecture §4b/§5): content flows
 * from git into the mirror, never back. The DB is rebuildable; the files are the
 * truth.
 */

/**
 * Sync reaches data through the {@link StoragePort} (ADR-0047), never through a
 * SQL executor. The alias exists so callers keep a name that says what it is for.
 */
export type SyncStore = StoragePort;

export type SyncAction =
  'upserted' | 'deleted' | 'skipped-self-write' | 'skipped-unchanged' | 'failed';

export interface SyncOutcome {
  readonly relativePath: string;
  readonly action: SyncAction;
  readonly hash?: string | undefined;
  readonly kind?: 'work_item' | 'doc' | undefined;
  /** Set only on `failed` — why this one file did not sync. */
  readonly error?: string | undefined;
}

/**
 * Called after a real content change lands. In v0.1 this is a no-op — retrieval
 * is `tsvector`-only and embeddings are v0.2 (mvp-slice) — but the seam exists
 * now so turning embeddings on is not a change to the sync pipeline.
 */
export type ReEmbedHook = (outcome: SyncOutcome) => void | Promise<void>;

/**
 * Called after every watcher-driven sync, success or failure.
 *
 * The watcher runs detached from any caller, so without this the daemon has no
 * way to report that a file failed to sync — and a silently dropped sync is
 * precisely the "looks fine, isn't" failure this product exists to prevent.
 */
export type SyncObserver = (outcome: SyncOutcome) => void;

export interface SyncEngineOptions {
  readonly workspaceRoot: string;
  readonly store: SyncStore;
  readonly onReEmbed?: ReEmbedHook | undefined;
  readonly registry?: SelfWriteRegistry | undefined;
  /** Notified after every watcher-driven sync. Errors arrive as `failed` outcomes. */
  readonly onSynced?: SyncObserver | undefined;
  /** Stability window for editor atomic-saves and agent write bursts. */
  readonly awaitWriteFinishMs?: number | undefined;
  /**
   * Force chokidar's polling backend instead of native OS events.
   *
   * Native backends (FSEvents on macOS, inotify on Linux) deliver on their own
   * schedule, which under heavy parallel load is neither prompt nor bounded.
   * That is fine in production — a sync arriving a second late is invisible —
   * but it makes a test assert on the operating system's mood. Polling trades
   * CPU for determinism, which is the right trade for a test and the wrong one
   * for a daemon, hence opt-in.
   */
  readonly usePolling?: boolean | undefined;
}

/** Work-item ID → the `work_items` row; anything else lands in `docs`. */
function classify(relativePath: string): 'work_item' | 'doc' {
  return relativePath.replace(/\\/g, '/').startsWith('kanban/') ? 'work_item' : 'doc';
}

function docTypeFor(relativePath: string): string {
  const normalised = relativePath.replace(/\\/g, '/');
  if (normalised.includes('/architectural-design-decisions/')) return 'decision';
  if (normalised.includes('/.research/')) return 'research';
  if (normalised.endsWith('/constitution.md')) return 'constitution';
  return 'spec';
}

export class SyncEngine {
  readonly #root: string;
  readonly #store: SyncStore;
  readonly #registry: SelfWriteRegistry;
  readonly #onReEmbed: ReEmbedHook | undefined;
  readonly #onSynced: SyncObserver | undefined;
  readonly #awaitWriteFinishMs: number;
  readonly #usePolling: boolean;
  #watcher: FSWatcher | undefined;

  constructor(options: SyncEngineOptions) {
    this.#root = path.resolve(options.workspaceRoot);
    this.#store = options.store;
    this.#registry = options.registry ?? new SelfWriteRegistry();
    this.#onReEmbed = options.onReEmbed;
    this.#onSynced = options.onSynced;
    this.#awaitWriteFinishMs = options.awaitWriteFinishMs ?? 300;
    this.#usePolling = options.usePolling ?? false;
  }

  /** The registry the daemon's own writer must record into before writing. */
  get registry(): SelfWriteRegistry {
    return this.#registry;
  }

  /**
   * Processes one file into the mirror.
   *
   * Ordering is the load-bearing part: the self-write claim is checked *before*
   * the hash comparison, because a daemon write and an external edit can produce
   * the same bytes, and only the registry can tell them apart.
   */
  async syncFile(absolutePath: string): Promise<SyncOutcome> {
    const relativePath = path.relative(this.#root, absolutePath).replace(/\\/g, '/');

    let raw: string;
    try {
      raw = await fs.readFile(absolutePath, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.#delete(relativePath);
      }
      throw cause;
    }

    const hash = contentHash(raw);

    if (this.#registry.claim(relativePath, hash)) {
      return { relativePath, action: 'skipped-self-write', hash };
    }

    const kind = classify(relativePath);
    const table: MirrorTable = kind === 'work_item' ? 'work_items' : 'docs';
    if ((await this.#store.contentHashFor(table, relativePath)) === hash) {
      return { relativePath, action: 'skipped-unchanged', hash, kind };
    }

    const parsed = parseFrontmatter(raw);
    // Same fallback both tables use for their primary key.
    const sourceId = typeof parsed.data['id'] === 'string' ? parsed.data['id'] : relativePath;

    if (kind === 'work_item') {
      await this.#upsertWorkItem(relativePath, hash, parsed.data);
    } else {
      await this.#upsertDoc(relativePath, hash, parsed.data);
    }
    await this.#reindexChunks(table, sourceId, relativePath, parsed.body);

    const outcome: SyncOutcome = { relativePath, action: 'upserted', hash, kind };
    await this.#onReEmbed?.(outcome);
    return outcome;
  }

  async #upsertWorkItem(
    relativePath: string,
    hash: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof data['id'] === 'string' ? data['id'] : null;
    if (id === null) {
      throw new Error(`${relativePath}: work-item frontmatter has no id`);
    }
    const str = (key: string): string | undefined =>
      typeof data[key] === 'string' ? data[key] : undefined;

    await this.#store.upsertWorkItem({
      id,
      type: str('kind') ?? str('type') ?? '',
      title: str('title') ?? '',
      status: str('status') ?? '',
      lifecycleState: str('lifecycle_state') ?? '',
      workType: str('work_type'),
      preset: str('preset'),
      riskLevel: str('risk_level'),
      filePath: relativePath,
      contentHash: hash,
    });
  }

  async #upsertDoc(
    relativePath: string,
    hash: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.#store.upsertDoc({
      id: typeof data['id'] === 'string' ? data['id'] : relativePath,
      docType: docTypeFor(relativePath),
      filePath: relativePath,
      contentHash: hash,
      title: typeof data['title'] === 'string' ? data['title'] : undefined,
      metadata: data,
    });
  }

  /**
   * Rewrites this source's chunk rows so retrieval can search body text.
   *
   * Without this the `embeddings` table stays empty and `createTsvectorRetriever`
   * has nothing to match — document bodies were parsed and then discarded, so no
   * content existed in the mirror at all (P0-SPIKE-02, D3).
   *
   * Delete-then-insert rather than a diff: chunk boundaries move when a heading
   * is added, so chunk 4 of the old text and chunk 4 of the new text are not the
   * same unit and matching them up would be fiction. Both statements run inside
   * one transaction so a crash cannot leave a doc indexed as zero chunks.
   *
   * `embedding` is left NULL — vectors are v0.2 (mvp-slice). The rows are still
   * useful now because `chunk_tsv` is generated from `chunk_text` on write.
   */
  async #reindexChunks(
    sourceTable: MirrorTable,
    sourceId: string,
    relativePath: string,
    body: string,
  ): Promise<void> {
    const chunks = chunkFile(body, relativePath).map((chunk) => {
      const text = indexableText(chunk);
      return {
        index: chunk.index,
        text,
        contentHash: contentHash(text),
        ...(chunk.breadcrumb.length === 0 ? {} : { breadcrumb: chunk.breadcrumb }),
      };
    });
    await this.#store.replaceChunks(sourceTable, sourceId, chunks);
  }

  async #delete(relativePath: string): Promise<SyncOutcome> {
    const table: MirrorTable = classify(relativePath) === 'work_item' ? 'work_items' : 'docs';
    await this.#store.removeByPath(table, relativePath);
    return { relativePath, action: 'deleted' };
  }

  /**
   * Walks the managed tree once and syncs everything.
   *
   * Runs at startup before watching, so a workspace edited while the daemon was
   * stopped is reconciled rather than silently stale.
   *
   * A file that fails to sync is reported as a `failed` outcome rather than
   * thrown: one malformed card must not stop the other nine hundred from
   * reaching the mirror. The caller decides what a partial reconcile means —
   * this method's job is to report accurately, not to give up early.
   *
   * Deletions are pruned as well as additions applied. Walking alone converges
   * the mirror only for files that still exist; a card deleted while the daemon
   * was stopped would otherwise stay in the mirror forever, and a stale chunk is
   * retrieved as truth. "Reconcile" has to mean both directions or the mirror is
   * not rebuildable from the tree (architecture §5, invariant 1).
   */
  async reconcile(): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    const walked: string[] = [];

    for (const dir of ['kanban', 'docs']) {
      const absolute = path.join(this.#root, dir);
      // Only prune under a directory we actually managed to read. A transient
      // readdir failure must not be mistaken for "the user deleted everything".
      if (!(await this.#isReadableDir(absolute))) continue;
      walked.push(dir);
      outcomes.push(...(await this.#walk(absolute)));
    }

    outcomes.push(...(await this.#prune(walked, outcomes)));
    return outcomes;
  }

  async #isReadableDir(absolute: string): Promise<boolean> {
    try {
      await fs.readdir(absolute);
      return true;
    } catch {
      return false;
    }
  }

  /** Drops mirror rows (and their chunks) whose source file is gone from disk. */
  async #prune(walked: readonly string[], seen: readonly SyncOutcome[]): Promise<SyncOutcome[]> {
    if (walked.length === 0) return [];
    const present = new Set(seen.map((outcome) => outcome.relativePath));
    const outcomes: SyncOutcome[] = [];

    for (const table of ['work_items', 'docs'] as const) {
      for (const row of await this.#store.mirroredPaths(table)) {
        const prefix = row.filePath.split('/')[0] ?? '';
        if (!walked.includes(prefix)) continue;
        if (present.has(row.filePath)) continue;
        outcomes.push(await this.#delete(row.filePath));
      }
    }
    return outcomes;
  }

  async #walk(dir: string): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return outcomes;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        outcomes.push(...(await this.#walk(full)));
      } else if (entry.name.endsWith('.md')) {
        try {
          outcomes.push(await this.syncFile(full));
        } catch (cause) {
          outcomes.push({
            relativePath: path.relative(this.#root, full).replace(/\\/g, '/'),
            action: 'failed',
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    return outcomes;
  }

  /**
   * Starts watching. `ignoreInitial` is deliberate — {@link reconcile} already
   * walked the tree, and re-processing it here would double every startup.
   */
  async start(): Promise<void> {
    if (this.#watcher) return;

    this.#watcher = chokidar.watch(
      [path.join(this.#root, 'kanban'), path.join(this.#root, 'docs')],
      {
        ignoreInitial: true,
        usePolling: this.#usePolling,
        ...(this.#usePolling ? { interval: 50 } : {}),
        // Absorbs editor atomic-saves (write-temp-then-rename) and agent write
        // bursts, which otherwise fire on a partially-written file.
        awaitWriteFinish: {
          stabilityThreshold: this.#awaitWriteFinishMs,
          pollInterval: 50,
        },
      },
    );

    const handle = (absolutePath: string): void => {
      if (!absolutePath.endsWith('.md')) return;
      const relative = path.relative(this.#root, absolutePath).replace(/\\/g, '/');
      if (!isManagedContentPath(relative)) return;

      // Never swallowed: a failure becomes a `failed` outcome the observer sees.
      // Silently dropping it would leave the mirror wrong with nothing to show
      // for it, which is the exact failure mode this product exists to prevent.
      void this.syncFile(absolutePath)
        .then((outcome) => this.#onSynced?.(outcome))
        .catch((cause: unknown) => {
          this.#onSynced?.({
            relativePath: relative,
            action: 'failed',
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    };

    this.#watcher.on('add', handle).on('change', handle).on('unlink', handle);

    await new Promise<void>((resolve) => {
      this.#watcher?.once('ready', () => resolve());
    });
  }

  async stop(): Promise<void> {
    await this.#watcher?.close();
    this.#watcher = undefined;
    this.#registry.clear();
  }
}

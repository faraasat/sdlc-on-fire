import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { contentHash, isManagedContentPath } from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { SelfWriteRegistry } from './self-write-registry.js';

/**
 * The Markdown → DB mirror (`.research/03`).
 *
 * Direction is one-way and non-negotiable (architecture §4b/§5): content flows
 * from git into the mirror, never back. The DB is rebuildable; the files are the
 * truth.
 */

/** Minimal DB surface, so the sync engine never imports the adapter. */
export interface SyncStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

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

export interface SyncEngineOptions {
  readonly workspaceRoot: string;
  readonly store: SyncStore;
  readonly onReEmbed?: ReEmbedHook | undefined;
  readonly registry?: SelfWriteRegistry | undefined;
  /** Stability window for editor atomic-saves and agent write bursts. */
  readonly awaitWriteFinishMs?: number | undefined;
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
  readonly #awaitWriteFinishMs: number;
  #watcher: FSWatcher | undefined;

  constructor(options: SyncEngineOptions) {
    this.#root = path.resolve(options.workspaceRoot);
    this.#store = options.store;
    this.#registry = options.registry ?? new SelfWriteRegistry();
    this.#onReEmbed = options.onReEmbed;
    this.#awaitWriteFinishMs = options.awaitWriteFinishMs ?? 300;
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
    const table = kind === 'work_item' ? 'work_items' : 'docs';
    const existing = await this.#store.query<{ content_hash: string }>(
      `SELECT content_hash FROM ${table} WHERE file_path = $1;`,
      [relativePath],
    );
    if (existing[0]?.content_hash === hash) {
      return { relativePath, action: 'skipped-unchanged', hash, kind };
    }

    const parsed = parseFrontmatter(raw);
    if (kind === 'work_item') {
      await this.#upsertWorkItem(relativePath, hash, parsed.data);
    } else {
      await this.#upsertDoc(relativePath, hash, parsed.data);
    }

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
    await this.#store.query(
      `INSERT INTO work_items
         (id, type, title, status, lifecycle_state, work_type, preset, risk_level, file_path, content_hash, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type, title = EXCLUDED.title, status = EXCLUDED.status,
         lifecycle_state = EXCLUDED.lifecycle_state, work_type = EXCLUDED.work_type,
         preset = EXCLUDED.preset, risk_level = EXCLUDED.risk_level,
         file_path = EXCLUDED.file_path, content_hash = EXCLUDED.content_hash,
         updated_at = now();`,
      [
        id,
        data['kind'],
        data['title'],
        data['status'],
        data['lifecycle_state'],
        data['work_type'] ?? null,
        data['preset'] ?? null,
        data['risk_level'] ?? null,
        relativePath,
        hash,
      ],
    );
  }

  async #upsertDoc(
    relativePath: string,
    hash: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const id = typeof data['id'] === 'string' ? data['id'] : relativePath;
    await this.#store.query(
      `INSERT INTO docs (id, doc_type, file_path, content_hash, title, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET
         doc_type = EXCLUDED.doc_type, file_path = EXCLUDED.file_path,
         content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
         metadata = EXCLUDED.metadata, updated_at = now();`,
      [
        id,
        docTypeFor(relativePath),
        relativePath,
        hash,
        typeof data['title'] === 'string' ? data['title'] : null,
        JSON.stringify(data),
      ],
    );
  }

  async #delete(relativePath: string): Promise<SyncOutcome> {
    const table = classify(relativePath) === 'work_item' ? 'work_items' : 'docs';
    await this.#store.query(`DELETE FROM ${table} WHERE file_path = $1;`, [relativePath]);
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
   */
  async reconcile(): Promise<SyncOutcome[]> {
    const outcomes: SyncOutcome[] = [];
    for (const dir of ['kanban', 'docs']) {
      outcomes.push(...(await this.#walk(path.join(this.#root, dir))));
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
      void this.syncFile(absolutePath).catch(() => undefined);
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

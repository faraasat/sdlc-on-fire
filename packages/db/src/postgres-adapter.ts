import type {
  ChunkHit,
  ChunkRecord,
  DocMirror,
  MirrorStage,
  MirrorTable,
  StorageCapabilities,
  StoragePort,
  WorkItemMirror,
} from '@sdlc-on-fire/core';

/**
 * The Postgres adapter for {@link StoragePort} (ADR-0047, P0-DB-07).
 *
 * This is the *only* module in the system that knows our data lives in
 * Postgres. Everything above it speaks the port's vocabulary, which is what
 * makes a second store an adapter rather than a rewrite.
 *
 * It deliberately does **not** re-export its executor. Handing callers a way to
 * run arbitrary SQL would rebuild the coupling the port exists to remove — the
 * seam only holds if going around it is inconvenient.
 */

/** The minimal driver surface an adapter needs. Satisfied by PGlite and node-postgres alike. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** `embeddings.model` for a chunk indexed but not embedded (v0.1 is tsvector-only). */
export const UNEMBEDDED_MODEL = 'none';

/**
 * Probes what this database can actually do.
 *
 * Reads the catalog rather than trusting configuration: a connection string
 * that mentions Supabase proves nothing about whether `vector` is installed on
 * the database it points at.
 */
export async function probeStorageCapabilities(
  executor: SqlExecutor,
): Promise<StorageCapabilities> {
  const extensions = await executor.query<{ extname: string }>('SELECT extname FROM pg_extension;');
  const names = new Set(extensions.map((row) => row.extname));

  const tsv = await executor.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'embeddings' AND column_name = 'chunk_tsv';`,
  );

  return {
    vectorSearch: names.has('vector'),
    fullTextSearch: (tsv[0]?.n ?? 0) > 0,
    transactions: true,
  };
}

export class PostgresStorageAdapter implements StoragePort {
  readonly #executor: SqlExecutor;
  readonly capabilities: StorageCapabilities;

  constructor(executor: SqlExecutor, capabilities: StorageCapabilities) {
    this.#executor = executor;
    this.capabilities = capabilities;
  }

  /** Probes capabilities, then binds them — so `capabilities` is never a guess. */
  static async create(executor: SqlExecutor): Promise<PostgresStorageAdapter> {
    return new PostgresStorageAdapter(executor, await probeStorageCapabilities(executor));
  }

  async upsertWorkItem(row: WorkItemMirror): Promise<void> {
    await this.#executor.query(
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
        row.id,
        row.type,
        row.title,
        row.status,
        row.lifecycleState,
        row.workType ?? null,
        row.preset ?? null,
        row.riskLevel ?? null,
        row.filePath,
        row.contentHash,
      ],
    );
  }

  async upsertDoc(row: DocMirror): Promise<void> {
    await this.#executor.query(
      `INSERT INTO docs (id, doc_type, file_path, content_hash, title, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET
         doc_type = EXCLUDED.doc_type, file_path = EXCLUDED.file_path,
         content_hash = EXCLUDED.content_hash, title = EXCLUDED.title,
         metadata = EXCLUDED.metadata, updated_at = now();`,
      [
        row.id,
        row.docType,
        row.filePath,
        row.contentHash,
        row.title ?? null,
        JSON.stringify(row.metadata ?? {}),
      ],
    );
  }

  async contentHashFor(table: MirrorTable, filePath: string): Promise<string | null> {
    const rows = await this.#executor.query<{ content_hash: string }>(
      `SELECT content_hash FROM ${assertTable(table)} WHERE file_path = $1;`,
      [filePath],
    );
    return rows[0]?.content_hash ?? null;
  }

  async mirroredPaths(table: MirrorTable): Promise<readonly { id: string; filePath: string }[]> {
    const rows = await this.#executor.query<{ id: string; file_path: string }>(
      `SELECT id, file_path FROM ${assertTable(table)};`,
    );
    return rows.map((row) => ({ id: row.id, filePath: row.file_path }));
  }

  async removeByPath(table: MirrorTable, filePath: string): Promise<void> {
    const name = assertTable(table);
    const owner = await this.#executor.query<{ id: string }>(
      `SELECT id FROM ${name} WHERE file_path = $1;`,
      [filePath],
    );
    await this.#executor.query(`DELETE FROM ${name} WHERE file_path = $1;`, [filePath]);

    const id = owner[0]?.id;
    if (id === undefined) return;
    // Hard delete, not a tombstone: the file is gone from git, so there is no
    // source to reconcile against and a stale chunk would retrieve as truth.
    await this.#executor.query(
      'DELETE FROM embeddings WHERE source_table = $1 AND source_id = $2;',
      [name, id],
    );
  }

  async replaceChunks(
    table: MirrorTable,
    sourceId: string,
    chunks: readonly ChunkRecord[],
  ): Promise<void> {
    const name = assertTable(table);
    await this.#executor.query('BEGIN;');
    try {
      await this.#executor.query(
        'DELETE FROM embeddings WHERE source_table = $1 AND source_id = $2;',
        [name, sourceId],
      );
      for (const chunk of chunks) {
        await this.#executor.query(
          `INSERT INTO embeddings
             (source_table, source_id, chunk_index, chunk_text, content_hash, model, heading_breadcrumb)
           VALUES ($1,$2,$3,$4,$5,$6,$7);`,
          [
            name,
            sourceId,
            chunk.index,
            chunk.text,
            chunk.contentHash,
            UNEMBEDDED_MODEL,
            chunk.breadcrumb ?? null,
          ],
        );
      }
      await this.#executor.query('COMMIT;');
    } catch (error) {
      await this.#executor.query('ROLLBACK;');
      throw error;
    }
  }

  async searchChunks(query: string, limit: number): Promise<readonly ChunkHit[]> {
    // Honour the probe rather than issuing SQL that would throw. An adapter
    // without full-text support returns nothing, which callers already handle.
    if (!this.capabilities.fullTextSearch) return [];

    const rows = await this.#executor.query<{
      source_table: string;
      source_id: string;
      chunk_index: number;
      chunk_text: string;
      heading_breadcrumb: string | null;
      rank: number;
    }>(
      `SELECT source_table, source_id, chunk_index, chunk_text, heading_breadcrumb,
              ts_rank_cd(chunk_tsv, websearch_to_tsquery('english', $1)) AS rank
         FROM embeddings
        WHERE chunk_tsv @@ websearch_to_tsquery('english', $1)
          AND tombstoned_at IS NULL
        ORDER BY rank DESC
        LIMIT $2;`,
      [query, limit],
    );

    return rows.map((row) => ({
      sourceTable: row.source_table as MirrorTable,
      sourceId: row.source_id,
      index: row.chunk_index,
      text: row.chunk_text,
      score: Number(row.rank),
      ...(row.heading_breadcrumb === null ? {} : { breadcrumb: row.heading_breadcrumb }),
    }));
  }

  async resetMirror(): Promise<void> {
    // Order matters only for readability — `embeddings` has no FK to the mirror
    // tables (contract 01 §2 keeps `source_id` polymorphic and unconstrained),
    // so a dangling chunk is self-healing rather than a constraint violation.
    // `evidence`, `gates`, `approvals` and `audit_log` are untouched by design.
    await this.#executor.query('DELETE FROM embeddings;');
    await this.#executor.query('DELETE FROM docs;');
    await this.#executor.query('DELETE FROM work_items;');
  }

  async stageOf(workItemId: string): Promise<MirrorStage | null> {
    const rows = await this.#executor.query<{ lifecycle_state: string; status: string }>(
      'SELECT lifecycle_state, status FROM work_items WHERE id = $1;',
      [workItemId],
    );
    const row = rows[0];
    return row === undefined ? null : { lifecycleState: row.lifecycle_state, status: row.status };
  }
}

/**
 * Guards the one place a table name reaches SQL as an identifier.
 *
 * `MirrorTable` is a closed union, so a valid caller cannot get here with
 * anything else — but identifiers cannot be parameterised, and "the type system
 * said so" is not a control at a SQL boundary reachable from parsed frontmatter.
 */
function assertTable(table: MirrorTable): 'work_items' | 'docs' {
  if (table !== 'work_items' && table !== 'docs') {
    throw new Error(`unknown mirror table: ${String(table)}`);
  }
  return table;
}

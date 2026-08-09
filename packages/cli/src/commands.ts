import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DOCS_ROOT_FILES,
  EAGER_DIRECTORIES,
  EAGER_STATE_SUBDIRS,
  GITIGNORE_ENTRIES,
  ROOT_FILES,
  WorkspaceConfigSchema,
  resolveWorkspaceLayout,
  type WorkspaceConfig,
} from '@sdlc-on-fire/core';

/**
 * Command implementations, kept separate from the Commander wiring.
 *
 * Every command returns **data**, never printed text. The `--json` twin is then
 * the same value serialized, rather than a second code path that can drift from
 * the human output — which is the failure mode `--json` flags usually have.
 */

export interface InitResult {
  readonly root: string;
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly alreadyInitialised: boolean;
}

export interface StatusResult {
  readonly root: string;
  readonly initialised: boolean;
  readonly configPath: string;
  readonly databaseMode: string | null;
  readonly counts: { readonly workItems: number | null; readonly docs: number | null };
}

/** Reads and validates `.sdlcof/config.yaml`. Returns `null` when absent. */
export async function readConfig(root: string): Promise<WorkspaceConfig | null> {
  const layout = resolveWorkspaceLayout(root);
  let raw: string;
  try {
    raw = await fs.readFile(layout.configPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
  return WorkspaceConfigSchema.parse(parseYaml(raw) ?? {});
}

/**
 * Scaffolds the workspace.
 *
 * Never overwrites: an existing file is reported as skipped, not replaced.
 * `init` running over a real project must be safe to run twice, and clobbering
 * a user's `README.md` would be unforgivable for a one-character typo.
 */
export async function init(root: string): Promise<InitResult> {
  const layout = resolveWorkspaceLayout(root);
  const created: string[] = [];
  const skipped: string[] = [];

  const alreadyInitialised = (await readConfig(root)) !== null;

  const ensureDir = async (dir: string): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
  };

  const ensureFile = async (file: string, contents: string): Promise<void> => {
    const relative = path.relative(layout.root, file);
    try {
      await fs.writeFile(file, contents, { flag: 'wx' });
      created.push(relative);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') skipped.push(relative);
      else throw cause;
    }
  };

  await ensureDir(layout.stateDir);
  for (const sub of EAGER_STATE_SUBDIRS) await ensureDir(path.join(layout.stateDir, sub));
  for (const dir of EAGER_DIRECTORIES) await ensureDir(path.join(layout.root, dir));

  for (const file of ROOT_FILES) {
    await ensureFile(path.join(layout.root, file), `# ${file.replace(/\.md$/, '')}\n`);
  }
  for (const file of DOCS_ROOT_FILES) {
    await ensureFile(path.join(layout.docsDir, file), `# ${file.replace(/\.md$/, '')}\n`);
  }

  await ensureFile(
    layout.configPath,
    ['# SDLC on Fire workspace config', 'database:', '  mode: pglite', 'preset: standard', ''].join(
      '\n',
    ),
  );

  // The state dir is machine-only and rebuildable (ADR-0006). Appended rather
  // than written, so an existing .gitignore is preserved.
  const gitignore = path.join(layout.root, '.gitignore');
  const existing = await fs.readFile(gitignore, 'utf8').catch(() => '');
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length > 0) {
    await fs.writeFile(
      gitignore,
      `${existing}${existing.endsWith('\n') || existing === '' ? '' : '\n'}${missing.join('\n')}\n`,
    );
    if (existing === '') created.push('.gitignore');
  }

  return { root: layout.root, created, skipped, alreadyInitialised };
}

export interface StatusStore {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Reports workspace state.
 *
 * Counts come back `null` rather than `0` when no database is reachable — "we
 * could not look" and "there are none" are different answers, and collapsing
 * them would let a broken daemon read as an empty project.
 */
export async function status(root: string, store?: StatusStore): Promise<StatusResult> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);

  let workItems: number | null = null;
  let docs: number | null = null;
  if (store) {
    const wi = await store.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM work_items;',
    );
    const d = await store.query<{ count: number }>('SELECT count(*)::int AS count FROM docs;');
    workItems = wi[0]?.count ?? 0;
    docs = d[0]?.count ?? 0;
  }

  return {
    root: layout.root,
    initialised: config !== null,
    configPath: layout.configPath,
    databaseMode: config?.database.mode ?? null,
    counts: { workItems, docs },
  };
}

export interface NewItemResult {
  readonly id: string;
  readonly filePath: string;
  readonly kind: string;
}

/** Assigns the next free sequence for a kind by scanning existing files. */
export async function nextSequence(kanbanDir: string, prefix: string): Promise<number> {
  const seen: number[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const match = new RegExp(`^${prefix}-(\\d+)`).exec(entry.name);
        if (match?.[1] !== undefined) seen.push(Number.parseInt(match[1], 10));
      }
    }
  };
  await walk(kanbanDir);
  return seen.length === 0 ? 1 : Math.max(...seen) + 1;
}

export interface ConfigResult {
  readonly configPath: string;
  readonly config: WorkspaceConfig | null;
}

export async function showConfig(root: string): Promise<ConfigResult> {
  const layout = resolveWorkspaceLayout(root);
  return { configPath: layout.configPath, config: await readConfig(root) };
}

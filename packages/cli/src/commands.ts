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
  docsToGenerate,
  isLifecycleStage,
  isTerminalStage,
  nextStage,
  resolveRequiredStages,
  resolveWorkspaceLayout,
  type Preset,
  type WorkspaceConfig,
} from '@sdlc-on-fire/core';
import { fillSlots, skillForStage } from '@sdlc-on-fire/agent-manager';
import { estimateTokens } from '@sdlc-on-fire/context';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { applySchema, provisionPglite, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { rebuildMirror } from '@sdlc-on-fire/daemon';

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

  // Honour the config's doc-generation toggles rather than always emitting the
  // full set. `docsToGenerate` existed and was tested from the day P0-OBJ-02
  // landed, but nothing called it — so a user who narrowed `docs.generate` got
  // every file anyway, and the setting silently did nothing.
  const existingConfig = await readConfig(root);
  const docs = existingConfig === null ? DOCS_ROOT_FILES : docsToGenerate(existingConfig);
  for (const file of docs) {
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

export interface InstructionsWorkItem {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly preset: string;
  readonly workType: string;
  readonly stage: string;
  readonly filePath: string;
}

export interface InstructionsSkill {
  readonly name: string;
  readonly stage: string;
  readonly role: string;
  readonly task: string;
  readonly stopCondition: string;
  readonly outputContract: { readonly toolName: string; readonly jsonSchemaRef?: string };
}

export interface InstructionsResult {
  readonly workItem: InstructionsWorkItem;
  /** The stage that comes next on this item's resolved ladder; `null` at the end. */
  readonly nextStage: string | null;
  readonly terminal: boolean;
  /** The skill driving `nextStage`, or `null` when that stage is not an agent's job. */
  readonly skill: InstructionsSkill | null;
  /** Why there is no skill, when there isn't one. Always present, never inferred by a caller. */
  readonly reason: string | null;
  readonly context: {
    readonly cardCore: string;
    readonly skillStable: string;
    readonly estimatedTokens: number;
  } | null;
}

/** Locates a work item's card by id, anywhere in the kanban tree. */
export async function findWorkItem(
  kanbanDir: string,
  id: string,
): Promise<{ filePath: string; raw: string } | null> {
  const walk = async (dir: string): Promise<{ filePath: string; raw: string } | null> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found !== null) return found;
      } else if (entry.name.endsWith('.md')) {
        const raw = await fs.readFile(full, 'utf8');
        if (parseFrontmatter(raw).data['id'] === id) return { filePath: full, raw };
      }
    }
    return null;
  };
  return walk(kanbanDir);
}

/**
 * Answers "what happens next for this work item, and with what prompt".
 *
 * The next step is **computed** from the item's resolved stage ladder, never
 * suggested: `resolveRequiredStages` + `nextStage` are the deterministic
 * disposer (ADR-0040), so two callers asking the same question at the same
 * commit get the same answer. This command reports; it never advances anything.
 *
 * A stage with no skill is a real, expected answer rather than an error —
 * `test` belongs to the daemon and `done` is a gate outcome, so `skill` comes
 * back `null` with a `reason` saying which case it is. A caller that treated
 * "no skill" as "dispatch anything" would be routing around the gate.
 */
export async function instructions(root: string, id: string): Promise<InstructionsResult> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const parsed = parseFrontmatter(found.raw);
  const data = parsed.data;
  const read = (key: string, fallback: string): string =>
    typeof data[key] === 'string' ? data[key] : fallback;

  const preset = read('preset', 'standard');
  const workType = read('work_type', 'feature');
  const stage = read('lifecycle_state', '');

  const workItem: InstructionsWorkItem = {
    id,
    title: read('title', ''),
    kind: read('kind', read('type', '')),
    preset,
    workType,
    stage,
    filePath: path.relative(layout.root, found.filePath),
  };

  const ladder = resolveRequiredStages(preset as Preset, workType);
  if (ladder === null) {
    throw new Error(`no stage ladder for preset "${preset}" + work_type "${workType}"`);
  }

  // The card's stage is untrusted text until checked against the vocabulary.
  // Casting it would let a typo ("implment") fall through as a legitimate stage
  // that simply has no successor — reported as "terminal", which is a lie.
  if (!isLifecycleStage(stage)) {
    return {
      workItem,
      nextStage: null,
      terminal: false,
      skill: null,
      reason: `"${stage}" is not a lifecycle stage — ${workItem.filePath} needs a valid lifecycle_state.`,
      context: null,
    };
  }

  const next = nextStage(preset as Preset, workType, stage);
  if (next === null) {
    return {
      workItem,
      nextStage: null,
      terminal: isTerminalStage(stage),
      skill: null,
      reason: isTerminalStage(stage)
        ? `${id} is at "${stage}", the end of its ladder — nothing comes next.`
        : `"${stage}" is not on the ${preset}/${workType} ladder (${ladder.join(' → ')}).`,
      context: null,
    };
  }

  const skill = skillForStage(next);
  if (skill === undefined) {
    return {
      workItem,
      nextStage: next,
      terminal: false,
      skill: null,
      reason:
        next === 'test'
          ? 'The daemon runs verify at the test stage — no agent is dispatched.'
          : `No skill drives the "${next}" stage in v0.1.`,
      context: null,
    };
  }

  const skillStable = [skill.role, skill.stop_condition].join('\n\n');
  const cardCore = `# ${workItem.title}\n\n${parsed.body.trim()}`;

  return {
    workItem,
    nextStage: next,
    terminal: false,
    skill: {
      name: skill.name,
      stage: skill.stage,
      role: skill.role,
      task: fillSlots(skill.task, {
        work_item_id: id,
        work_item_title: workItem.title,
      }),
      stopCondition: skill.stop_condition,
      outputContract: {
        toolName: skill.output_contract.tool_name,
        ...(skill.output_contract.json_schema_ref !== undefined
          ? { jsonSchemaRef: skill.output_contract.json_schema_ref }
          : {}),
      },
    },
    reason: null,
    context: {
      cardCore,
      skillStable,
      estimatedTokens: estimateTokens(`${skillStable}\n\n${cardCore}`),
    },
  };
}

export interface RebuildCommandResult {
  readonly root: string;
  readonly workItems: number;
  readonly docs: number;
  readonly failed: readonly { readonly relativePath: string; readonly error: string }[];
  readonly durationMs: number;
}

/**
 * `sdlc db:rebuild` — throw the mirror away and rebuild it from the files.
 *
 * Safe by construction rather than by warning: the mirror is a cache of content
 * that lives in git, and evidence/gates/audit are deliberately outside what
 * `resetMirror` touches. There is nothing here to lose that git does not already
 * hold, which is the whole point of the invariant this command exercises.
 */
export async function rebuild(root: string): Promise<RebuildCommandResult> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  if (config === null) {
    throw new Error(`${layout.configPath} not found — run \`sdlc init\` first`);
  }

  const db = await provisionPglite({ workspaceRoot: layout.root });
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const result = await rebuildMirror(layout.root, port);
    return { root: layout.root, ...result };
  } finally {
    await db.close();
  }
}

export interface ConfigResult {
  readonly configPath: string;
  readonly config: WorkspaceConfig | null;
}

export async function showConfig(root: string): Promise<ConfigResult> {
  const layout = resolveWorkspaceLayout(root);
  return { configPath: layout.configPath, config: await readConfig(root) };
}

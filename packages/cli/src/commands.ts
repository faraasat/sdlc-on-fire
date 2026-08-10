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
  AdvancedConfigSchema,
  describeCapabilities,
  inertCapabilities,
  docsToGenerate,
  isLifecycleStage,
  isTerminalStage,
  nextStage,
  resolveRequiredStages,
  loadTierPolicy,
  undeclaredModels,
  resolveWorkspaceLayout,
  type CapabilityDiscoveryRow,
  type Preset,
  type WorkspaceConfig,
} from '@sdlc-on-fire/core';
import {
  CANONICAL_SKILLS,
  fillSlots,
  resolveTier,
  skillForStage,
  tierPolicyFromConfig,
} from '@sdlc-on-fire/agent-manager';
import { estimateTokens } from '@sdlc-on-fire/context';
import { parseFrontmatter, renderWorkItem } from '@sdlc-on-fire/storage';
import { attestAll, attestItem, type Attestation, type TreeContext } from './attest.js';
import { currentDirtyTreeHash } from './verify.js';
import {
  applySchema,
  connectToPostgres,
  provisionPglite,
  PostgresStorageAdapter,
  type SqlExecutor,
} from '@sdlc-on-fire/db';
import {
  createGitManager,
  installGitHooks,
  rebuildMirror,
  syncChangedPaths,
  type InstallHooksResult,
} from '@sdlc-on-fire/daemon';

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
  const parsed = WorkspaceConfigSchema.safeParse(parseYaml(raw) ?? {});
  if (parsed.success) return parsed.data;

  // Zod's default rendering is a JSON dump of issue objects. Someone who
  // mistyped their config deserves the sentence, not the data structure — and
  // the path, so they know which key to go and fix.
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`${layout.configPath} is not valid:\n${issues}`);
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

  // Open the mirror ourselves when no store was injected. Previously this
  // reported "(daemon not running)" on every single invocation — including
  // immediately after `db:rebuild` printed real, non-zero counts — which told a
  // user the tool was broken when it was merely not looking.
  let opened: { close(): Promise<void> } | undefined;
  if (store === undefined && config !== null) {
    try {
      const handle = await openWorkspaceDatabase(root);
      opened = handle.db;
      // A workspace can be initialised without ever having been synced, so the
      // tables may not exist yet. `applySchema` is idempotent and cheap on an
      // already-migrated database; without it, `status` on a fresh workspace
      // fails with `relation "work_items" does not exist`.
      await applySchema(handle.db);
      store = handle.db;
    } catch {
      // Genuinely unreachable (locked by a running daemon, bad connection
      // string). `null` counts below then mean "could not look", which is the
      // honest answer and distinct from "there are none".
    }
  }

  if (store) {
    const wi = await store.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM work_items;',
    );
    const d = await store.query<{ count: number }>('SELECT count(*)::int AS count FROM docs;');
    workItems = wi[0]?.count ?? 0;
    docs = d[0]?.count ?? 0;
  }

  await opened?.close();

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
  /**
   * Whether a terminal claim survives its own evidence.
   *
   * `instructions` is the command an agent reads before deciding what to do
   * next, so it is exactly where an unsupported `done` must not go unmentioned.
   * A blind evaluation hand-edited a card to `done` and this command replied
   * "nothing comes next" with no hint that the item's recorded verify run had
   * failed — the tool politely repeating the lie back.
   */
  readonly attestation: Attestation;
  readonly concern?: string | undefined;
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

/**
 * The tree a claim is attested against: HEAD plus any uncommitted state.
 *
 * Both halves are needed. HEAD alone cannot see an edit that was never
 * committed, and evidence produced against a dirty tree stays "current" forever
 * if the dirt is not part of the comparison.
 */
export async function treeContext(root: string): Promise<TreeContext> {
  const git = createGitManager({ repoRoot: root });
  const headSha = (await git.isRepo()) ? await git.headSha() : '0'.repeat(40);
  const dirty = await currentDirtyTreeHash(root);
  return { headSha, ...(dirty === undefined ? {} : { dirtyTreeHash: dirty }) };
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

  // Only terminal stages open the database. A mid-flight item has claimed
  // nothing, so there is nothing to attest and no reason to pay for a
  // connection.
  let attested: { attestation: Attestation; concern?: string | undefined } = {
    attestation: 'not-applicable',
  };
  if (isLifecycleStage(stage) && isTerminalStage(stage)) {
    const { db } = await openWorkspaceDatabase(root);
    try {
      await applySchema(db);
      attested = await attestItem(db, id, stage, await treeContext(layout.root));
    } finally {
      await db.close();
    }
  }
  const claim = {
    attestation: attested.attestation,
    ...(attested.concern === undefined ? {} : { concern: attested.concern }),
  };

  // The card's stage is untrusted text until checked against the vocabulary.
  // Casting it would let a typo ("implment") fall through as a legitimate stage
  // that simply has no successor — reported as "terminal", which is a lie.
  if (!isLifecycleStage(stage)) {
    return {
      workItem,
      ...claim,
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
      ...claim,
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
      ...claim,
      nextStage: next,
      terminal: false,
      skill: null,
      reason:
        next === 'test'
          ? // Names the command, not the component. A blind evaluation read
            // "the daemon runs verify", went looking for `sdlc daemon`, and
            // found nothing — the long-running daemon is deferred past v0.1, so
            // describing the mechanism by a name with no command behind it sent
            // them hunting for something that does not exist. What actually runs
            // verify today is this:
            `No agent is dispatched at the test stage — run \`sdlc verify ${id}\`, which executes the card's own \`verify:\` command and records the result as evidence.`
          : `No skill drives the "${next}" stage in v0.1.`,
      context: null,
    };
  }

  const skillStable = [skill.role, skill.stop_condition].join('\n\n');
  const cardCore = `# ${workItem.title}\n\n${parsed.body.trim()}`;

  return {
    workItem,
    ...claim,
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

/**
 * Opens the workspace's database in whichever mode the config names.
 *
 * One place decides this, so `db:rebuild` and `sync:batch` cannot disagree about
 * where the mirror lives — a rebuild that silently targeted PGlite while the
 * daemon wrote to Postgres would produce two mirrors and no error.
 */
export async function openWorkspaceDatabase(root: string): Promise<{
  db: SqlExecutor & { close(): Promise<void>; exec(sql: string): Promise<void> };
  mode: string;
  describe: string;
}> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  if (config === null) {
    throw new Error(`${layout.configPath} not found — run \`sdlc init\` first`);
  }

  if (config.database.mode === 'connected') {
    // `WorkspaceConfigSchema` already rejects a connected config with no url, so
    // this is defence in depth for a config built in code rather than read from
    // disk. Falling back to PGlite here would be the dangerous alternative: the
    // command would succeed against a different mirror than the daemon reads.
    const url = config.database.url;
    if (url === undefined || url.length === 0) {
      throw new Error(
        'database.mode is "connected" but database.url is not set — connected mode needs a ' +
          'postgres:// connection string (ADR-0068: we do not provision the server, you do)',
      );
    }
    const db = await connectToPostgres({ url });
    return { db, mode: 'connected', describe: db.safeUrl };
  }

  const db = await provisionPglite({ workspaceRoot: layout.root });
  return { db, mode: 'pglite', describe: db.dataDir };
}

export interface RebuildCommandResult {
  readonly root: string;
  readonly workItems: number;
  readonly docs: number;
  /** Files that actually needed rewriting. Zero is the healthy steady state. */
  readonly changed: number;
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
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const result = await rebuildMirror(layout.root, port);
    return { root: layout.root, ...result };
  } finally {
    await db.close();
  }
}

export interface SyncBatchResult {
  readonly root: string;
  readonly considered: number;
  readonly upserted: number;
  readonly deleted: number;
  readonly failed: readonly { readonly relativePath: string; readonly error: string }[];
}

/**
 * `sdlc sync:batch` — re-sync the paths git just changed (P0-SYNC-02).
 *
 * Invoked by the installed hooks after a commit, merge, checkout or rewrite.
 * Asks git which paths moved rather than re-walking the tree: a branch switch
 * touches what it touches, and re-reading a large repo on every checkout would
 * make the hook the slowest thing about using git.
 */
export async function syncBatch(root: string, since = 'HEAD'): Promise<SyncBatchResult> {
  const layout = resolveWorkspaceLayout(root);
  const git = createGitManager({ repoRoot: layout.root });
  if (!(await git.isRepo())) {
    throw new Error(`${layout.root} is not a git repository`);
  }

  const changed = await git.changedInCommit(since);
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    const result = await syncChangedPaths(layout.root, port, changed);

    return {
      root: layout.root,
      considered: result.considered,
      upserted: result.outcomes.filter((o) => o.action === 'upserted').length,
      deleted: result.outcomes.filter((o) => o.action === 'deleted').length,
      failed: result.outcomes
        .filter((o) => o.action === 'failed')
        .map((o) => ({ relativePath: o.relativePath, error: o.error ?? 'unknown' })),
    };
  } finally {
    await db.close();
  }
}

/** `sdlc hooks:install` — install the git hooks that drive `sync:batch`. */
export async function hooksInstall(root: string): Promise<InstallHooksResult & { root: string }> {
  const layout = resolveWorkspaceLayout(root);

  // Refuse outside a repository. `.git/hooks/` is a plain directory, so writing
  // into it succeeds whether or not git will ever look there — and a blind
  // evaluation was told hooks were installed in a workspace that had never been
  // `git init`'d. Reporting success for a file nothing will execute is worse
  // than failing: the user stops thinking about it.
  const git = createGitManager({ repoRoot: layout.root });
  if (!(await git.isRepo())) {
    throw new Error(
      `${layout.root} is not a git repository, so installed hooks would never run. ` +
        'Run `git init` first, then `sdlc hooks:install`.',
    );
  }

  return { root: layout.root, ...(await installGitHooks(layout.root)) };
}

export interface WorkItemListing {
  readonly id: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly status: string;
  readonly filePath: string;
  /** Whether a terminal claim is backed by recorded evidence. */
  readonly attestation: Attestation;
  readonly concern?: string | undefined;
}

/**
 * `sdlc list` — what is in the mirror.
 *
 * Syncs first. A list command that reported only what a previous sync happened
 * to catch would be answering a different question from the one asked, and the
 * first thing a user does after creating a work item is look for it.
 */
export async function listWorkItems(root: string): Promise<{ items: readonly WorkItemListing[] }> {
  const layout = resolveWorkspaceLayout(root);
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await rebuildMirror(layout.root, port);

    const rows = await db.query<{
      id: string;
      title: string;
      lifecycle_state: string;
      status: string;
      file_path: string;
    }>('SELECT id, title, lifecycle_state, status, file_path FROM work_items ORDER BY id;');

    const attestations = await attestAll(
      db,
      rows.map((row) => ({ id: row.id, lifecycleState: row.lifecycle_state })),
      await treeContext(layout.root),
    );
    const byId = new Map(attestations.map((entry) => [entry.id, entry]));

    return {
      items: rows.map((row) => {
        const attested = byId.get(row.id);
        return {
          id: row.id,
          title: row.title,
          lifecycleState: row.lifecycle_state,
          status: row.status,
          filePath: row.file_path,
          attestation: attested?.attestation ?? 'not-applicable',
          ...(attested?.concern === undefined ? {} : { concern: attested.concern }),
        };
      }),
    };
  } finally {
    await db.close();
  }
}

export interface CaptureResult {
  readonly id: string;
  readonly filePath: string;
  readonly title: string;
}

/**
 * `sdlc capture` — soft insertion (P1-INS-01, architecture §4d).
 *
 * The whole point is that it costs nothing to use. An idea arrives mid-task;
 * if capturing it requires choosing a kind, a parent, a preset and a lifecycle
 * stage, nobody captures anything and it goes in a text file instead — or is
 * lost. So this takes a sentence and nothing else, and lands in `_inbox` at
 * `capture`, deliberately outside any ladder.
 *
 * It must **not** disrupt work in flight: no claim is touched, no stage moves,
 * no gate is consulted. Triage is a separate, later, deliberate act.
 */
export async function captureItem(root: string, note: string): Promise<CaptureResult> {
  const layout = resolveWorkspaceLayout(root);
  const inbox = path.join(layout.kanbanDir, '_inbox');
  await fs.mkdir(inbox, { recursive: true });

  const sequence = await nextSequence(layout.kanbanDir, 'CAP');
  const id = `CAP-${String(sequence).padStart(3, '0')}`;
  const filePath = path.join(inbox, `${id}.md`);
  const now = new Date().toISOString();

  // Written as plain frontmatter rather than through the typed writer: a
  // capture is explicitly *not* a work item yet. Forcing it to satisfy the
  // work-item schema would reintroduce the ceremony this command exists to
  // avoid, and would make an unusable capture into a failed one.
  const card = [
    '---',
    `id: ${id}`,
    'kind: capture',
    `title: ${JSON.stringify(note)}`,
    'status: Inbox',
    'lifecycle_state: capture',
    `created_at: ${now}`,
    '---',
    '',
    '## Note',
    '',
    note,
    '',
    '## Triage',
    '',
    'Not yet triaged. `sdlc triage ' + id + ' --as <kind>` turns this into a work item.',
    '',
  ].join('\n');

  await fs.writeFile(filePath, card, 'utf8');
  return { id, filePath: path.relative(layout.root, filePath), title: note };
}

export interface TriageResult {
  readonly capturedId: string;
  readonly workItemId: string;
  readonly filePath: string;
  readonly kind: string;
}

/**
 * `sdlc triage` — promote a capture into a real work item.
 *
 * Deliberately a separate command from `capture`. Capturing is cheap and
 * frequent; deciding what something *is* costs thought and happens later, often
 * by someone else. Collapsing them would push that decision into the moment of
 * interruption, which is exactly when it is made worst.
 *
 * The capture file is left in place, superseded rather than deleted (ADR-0013):
 * the original wording is often the only record of what was actually meant.
 */
export async function triageItem(
  root: string,
  capturedId: string,
  kind: string,
  preset = 'standard',
): Promise<TriageResult> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, capturedId);
  if (found === null)
    throw new Error(`no capture with id "${capturedId}" under ${layout.kanbanDir}`);

  const parsed = parseFrontmatter(found.raw);
  const title = typeof parsed.data['title'] === 'string' ? parsed.data['title'] : capturedId;

  const { WORK_ITEM_ID_PREFIX, formatWorkItemId, kanbanColumnForStage, resolveRequiredStages } =
    await import('@sdlc-on-fire/core');

  if (!(kind in WORK_ITEM_ID_PREFIX)) {
    throw new Error(
      `unknown kind "${kind}" — expected one of ${Object.keys(WORK_ITEM_ID_PREFIX).join(', ')}`,
    );
  }
  const typedKind = kind as keyof typeof WORK_ITEM_ID_PREFIX;
  const workType = typedKind === 'bug' ? 'bug' : typedKind === 'task' ? 'task' : 'feature';
  const firstStage = resolveRequiredStages(preset as never, workType)?.[0];
  if (firstStage === undefined) {
    throw new Error(`no stage ladder for preset "${preset}" + work_type "${workType}"`);
  }

  const sequence = await nextSequence(layout.kanbanDir, WORK_ITEM_ID_PREFIX[typedKind]);
  const id = formatWorkItemId(typedKind, sequence);
  const now = new Date().toISOString();

  const item = {
    $schema: 'https://sdlc-on-fire.dev/schema/work-item.json',
    id,
    kind: typedKind,
    title,
    status: kanbanColumnForStage(firstStage),
    lifecycle_state: firstStage,
    work_type: workType,
    preset,
    risk_level: 'low' as const,
    created_at: now,
    updated_at: now,
    ...(typedKind === 'task' ? { verify: 'pnpm test', done: ['tests pass'] } : {}),
    ...(typedKind === 'bug' ? { repro_steps: ['TODO'], severity: 'medium' as const } : {}),
    ...(typedKind === 'story' ? { acceptance_criteria: ['GIVEN … WHEN … THEN …'] } : {}),
    ...(typedKind === 'feature'
      ? { acceptance_criteria: ['GIVEN … WHEN … THEN …'], spec_ref: 'TODO' }
      : {}),
    ...(typedKind === 'epic' ? { goal: 'TODO' } : {}),
  };

  const filePath = path.join(layout.kanbanDir, '_inbox', `${id}.md`);
  // Provenance goes in the body, not in `supersedes`: that field is defined for
  // work-item-to-work-item supersession (ADR-0013), and a capture is
  // deliberately not a work item. Recording it anyway would either fail
  // validation or quietly redefine what the field means.
  const body = [
    '## Description',
    '',
    parsed.body.trim(),
    '',
    `_Triaged from ${capturedId} — the original wording is often the only record of what was meant._`,
    '',
  ].join('\n');

  await fs.writeFile(filePath, renderWorkItem(item as never, body), 'utf8');

  return { capturedId, workItemId: id, filePath: path.relative(layout.root, filePath), kind };
}

export interface ClaimResult {
  readonly workItemId: string;
  readonly claimedBy: string;
  readonly leaseExpiresAt: string;
  readonly granted: boolean;
  readonly heldBy?: string | undefined;
}

/**
 * `sdlc claim` — take the work item before starting on it (ADR-0048).
 *
 * Exists because the invariant guard that requires a claim otherwise creates a
 * dead end: the tool refuses to advance, names the claim as the reason, and
 * offers no way to acquire one. A refusal a user cannot act on is worse than no
 * refusal at all — it teaches them the tool is broken rather than strict.
 */
export async function claimWorkItem(
  root: string,
  id: string,
  actor: string,
  leaseMinutes = 60,
): Promise<ClaimResult> {
  const layout = resolveWorkspaceLayout(root);
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await rebuildMirror(layout.root, port);

    const state = await port.claim({
      workItemId: id,
      actor,
      kind: 'human',
      leaseMs: leaseMinutes * 60_000,
    });

    if (state === null) {
      const held = await port.claimOf(id);
      return {
        workItemId: id,
        claimedBy: actor,
        leaseExpiresAt: '',
        granted: false,
        heldBy: held?.claimedBy ?? '(unknown — the work item may not exist)',
      };
    }
    return {
      workItemId: id,
      claimedBy: state.claimedBy,
      leaseExpiresAt: state.leaseExpiresAt,
      granted: true,
    };
  } finally {
    await db.close();
  }
}

export interface ConfigResult {
  readonly configPath: string;
  readonly config: WorkspaceConfig | null;
  /**
   * Capabilities the user turned on that nothing reads yet.
   */
  readonly inert: readonly { readonly key: string; readonly lands_in: string }[];
  /**
   * Every advanced capability with its default, current value, ADR and cost
   * class — on or off (ADR-0067). Listing only the enabled ones would make
   * "advanced" mean hidden; the point is that it means deliberate.
   */
  readonly capabilities: readonly CapabilityDiscoveryRow[];
}

/**
 * `sdlc agents` — what the tier policy actually routes to (P1-AGENT-08).
 *
 * The policy is easy to write and hard to predict: three overrides interacting
 * across a dozen skills is exactly the kind of thing people get wrong silently.
 * A resolution that can only be observed by dispatching is a resolution nobody
 * checks before spending on it — `explainPolicy` existed for this and had no
 * caller.
 */
export interface AgentsResult {
  readonly maxTier: string;
  readonly models: Readonly<Record<string, string>>;
  readonly routes: readonly {
    readonly skill: string;
    readonly tier: string;
    readonly source: string;
    readonly model: string;
    readonly fallbacks: readonly string[];
  }[];
  /** Skills that cannot route under this policy, with the reason. */
  readonly unroutable: readonly { readonly skill: string; readonly reason: string }[];
  /**
   * Routed models with no declared licensing/privacy/retention posture
   * (P1-SEC-01).
   *
   * Reported, never refused. The question belongs where the routing decision is
   * visible; a tool that refused to run without an answer would just be given a
   * fabricated one.
   */
  readonly undeclared: readonly string[];
}

export async function describeAgents(root: string): Promise<AgentsResult> {
  const config = await readConfig(root);
  const policyConfig = loadTierPolicy(config?.agents);
  const policy = tierPolicyFromConfig(policyConfig);

  const routes: {
    skill: string;
    tier: string;
    source: string;
    model: string;
    fallbacks: readonly string[];
  }[] = [];
  const unroutable: { skill: string; reason: string }[] = [];
  for (const skill of Object.values(CANONICAL_SKILLS)) {
    try {
      // Resolved one at a time rather than through `explainPolicy`, because one
      // unroutable skill must not hide the routing of the other eleven.
      const resolved = resolveTier(skill, policy);
      routes.push({
        skill: skill.name,
        tier: resolved.tier,
        source: resolved.source,
        model: resolved.model,
        fallbacks: resolved.fallbacks,
      });
    } catch (error) {
      unroutable.push({ skill: skill.name, reason: (error as Error).message });
    }
  }

  return {
    maxTier: policyConfig.max_tier,
    models: policyConfig.models,
    routes,
    unroutable,
    undeclared: undeclaredModels(policyConfig),
  };
}

export async function showConfig(root: string): Promise<ConfigResult> {
  const layout = resolveWorkspaceLayout(root);
  const config = await readConfig(root);
  const advanced = config?.advanced ?? AdvancedConfigSchema.parse({});
  return {
    configPath: layout.configPath,
    config,
    capabilities: describeCapabilities(advanced),
    // Listed separately so it cannot be missed in a long table. A capability the
    // user switched on that nothing reads is the one thing they most need told.
    inert: inertCapabilities(advanced).map((entry) => ({
      key: entry.key,
      lands_in: entry.implementedBy ?? '(unscheduled)',
    })),
  };
}

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
import { parse as parseYaml } from 'yaml';
import {
  DOCS_ROOT_FILES,
  INDEXED_DIRECTORIES,
  EAGER_DIRECTORIES,
  EAGER_STATE_SUBDIRS,
  GITIGNORE_ENTRIES,
  ESSENTIAL_ROOT_FILES,
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
  explainRequiredChecks,
  FocusProfileSchema,
  loadTierPolicy,
  undeclaredModels,
  resolveStageProfile,
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
  ensureHumanActor,
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
  /** Whether this call created the git repository. False when one already existed. */
  readonly initialisedGit: boolean;
  /**
   * Whether the database was actually brought up, and what happened if not.
   *
   * `init` used to create an empty `.sdlcof/db/` and report success; PGlite
   * only materialised when something later touched it. So on a machine where
   * the WASM runtime cannot start, `init` said "Workspace initialised." and the
   * failure surfaced several commands later, far from the setup step the user
   * was actually performing. The v0.1 DoD says `init` brings PGlite up — so it
   * does, and proves it.
   */
  readonly database: {
    readonly ready: boolean;
    /**
     * True when the database is fine and simply owned by another process —
     * somebody has `sdlc serve` running. Distinguished from a real failure so
     * the exit code can differ: this is the most ordinary setup there is and
     * must not fail the command, while a genuine failure must not be sailed
     * past by a script doing `sdlc init && …`.
     */
    readonly held?: boolean;
    readonly detail: string;
  };
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
export interface InitOptions {
  /**
   * Whether to start the database as part of the scaffold.
   *
   * Defaults to provisioning, which is what a user gets: `init` proves the
   * database can come up instead of reporting success and letting the failure
   * surface later. It costs about a second and 40 MB, so scaffolding tests that
   * never touch the mirror pass `'skip'` — the provisioning path stays covered
   * by its own test and by the DoD walk, rather than by every test paying for
   * a Postgres it does not use.
   */
  readonly database?: 'provision' | 'skip' | undefined;
  /**
   * How much to scaffold (P5-PILOT-02).
   *
   * Omitted means *detect*: a repository that already has a README and a
   * populated `docs/` gets the operating essentials only, an empty directory
   * gets the full set. `'full'` and `'minimal'` override the detection in
   * either direction, because a maintainer disagreeing with our guess about
   * their own repository should not have to work around it.
   */
  readonly scaffold?: 'full' | 'minimal' | undefined;
}

/**
 * Whether this repository already documents itself.
 *
 * Two signals, both weak alone and convincing together: a README that predates
 * us, and a `docs/` directory with markdown in it. A project with both has made
 * decisions about its own documentation, and the polite thing is to add as
 * little as possible to them.
 */
/**
 * Files that mean "somebody already works here", counted rather than guessed at.
 *
 * The first version of this asked for `README.md` **and** a `docs/` directory
 * containing at least one `.md`. It was validated against hono, which has
 * exactly that shape, and it silently failed on every repository that does not:
 *
 *   * **flask** — `docs/` full of Sphinx `.rst`, not a single `.md`
 *   * **cobra**, **ripgrep** — no `docs/` directory at all
 *   * **got** — its documentation lives in `documentation/`
 *
 * All four received the full 28-file greenfield scaffold from `0.1.0-alpha.2`,
 * which is the exact imposition the detection exists to prevent. The rule was
 * not wrong about hono; it was a JavaScript-ecosystem assumption about where
 * documentation lives, dressed as a general test.
 *
 * So it counts instead. "Does this directory already contain a project" needs
 * no opinion about languages, documentation formats or folder names, and an
 * empty directory answers it as clearly as flask does.
 */
const BROWNFIELD_FILE_THRESHOLD = 10;

/** Directories never worth walking into to answer this question. */
const UNCOUNTED = new Set([
  '.git',
  'node_modules',
  '.sdlc',
  '.sdlcof',
  'dist',
  'build',
  'target',
  'vendor',
]);

/**
 * Files present under `root`, counted no further than `limit`.
 *
 * Exported so the bound is checkable rather than merely claimed: the early stop
 * is invisible in the brownfield verdict — which is the same either way — and an
 * optimisation nothing observes is one a later reader deletes as dead weight.
 */
export async function countExistingFiles(root: string, limit: number): Promise<number> {
  let count = 0;
  const queue: string[] = [root];
  while (queue.length > 0 && count < limit) {
    const dir = queue.shift();
    if (dir === undefined) break;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (UNCOUNTED.has(entry.name)) continue;
      if (entry.isDirectory()) {
        queue.push(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        count += 1;
        // Stops as soon as the answer is decided. A monorepo with 40,000 files
        // must not pay for a full walk to learn what its tenth file already said.
        if (count >= limit) return count;
      }
    }
  }
  return count;
}

async function hasOwnConventions(layout: { root: string; docsDir: string }): Promise<boolean> {
  return (
    (await countExistingFiles(layout.root, BROWNFIELD_FILE_THRESHOLD)) >= BROWNFIELD_FILE_THRESHOLD
  );
}

/** One `git config` value, or undefined. Never throws: identity degrades, it does not fail. */
async function gitConfig(root: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', key], { cwd: root });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export async function init(root: string, options: InitOptions = {}): Promise<InitResult> {
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

  // Brownfield repositories get the operating essentials and nothing else.
  //
  // A project that already has a README and a populated `docs/` has decided how
  // it documents itself, and adding twenty-four files to that decision is how a
  // tool gets removed on day two. The full set is one command away
  // (`sdlc scaffold docs`) and is the default on an empty directory, where
  // there is no convention to intrude on.
  const brownfield =
    options.scaffold === 'minimal' ||
    (options.scaffold !== 'full' && (await hasOwnConventions(layout)));
  const rootFiles = brownfield ? ESSENTIAL_ROOT_FILES : ROOT_FILES;

  for (const file of rootFiles) {
    await ensureFile(path.join(layout.root, file), `# ${file.replace(/\.md$/, '')}\n`);
  }

  // Index-first (ADR-0053): a folder without a README is a folder an agent has
  // to scan, and an index nobody created at `init` is one nobody creates later.
  for (const [dir, contents] of Object.entries(INDEXED_DIRECTORIES)) {
    await ensureFile(path.join(layout.root, dir, 'README.md'), contents);
  }

  // Honour the config's doc-generation toggles rather than always emitting the
  // full set. `docsToGenerate` existed and was tested from the day P0-OBJ-02
  // landed, but nothing called it — so a user who narrowed `docs.generate` got
  // every file anyway, and the setting silently did nothing.
  const existingConfig = await readConfig(root);
  const docs = brownfield
    ? []
    : existingConfig === null
      ? DOCS_ROOT_FILES
      : docsToGenerate(existingConfig);
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

  // The workspace's whole premise is that content lives in git, and four
  // commands (`branch --create`, `hooks:install`, `verify`, `advance`) need a
  // repository to work at all. Scaffolding a workspace that cannot use them and
  // saying nothing left a first-time user to discover it from a refusal several
  // commands later — a blind evaluation hit exactly that.
  //
  // `git init` creates a repository and touches nothing that already exists, so
  // it is safe to run here; an existing repository is left entirely alone.
  const git = createGitManager({ repoRoot: layout.root });
  let initialisedGit = false;
  if (!(await git.isRepo())) {
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: layout.root });
      initialisedGit = true;
    } catch {
      // A machine without git is a real situation, and it is not a reason to
      // fail the scaffold — every file-based command still works. The status
      // line says what happened rather than pretending it succeeded.
      initialisedGit = false;
    }
  }

  // Bring the database up here rather than lazily. An `init` that reports
  // success without ever starting the thing it claims to have set up is the
  // same self-report this product exists to refuse.
  let database: InitResult['database'];
  if (options.database === 'skip') {
    return {
      root: layout.root,
      created,
      skipped,
      alreadyInitialised,
      initialisedGit,
      database: { ready: false, detail: 'database provisioning skipped by the caller' },
    };
  }
  try {
    const handle = await provisionPglite({ workspaceRoot: layout.root });
    try {
      await applySchema(handle);

      // Bootstrap the human. The schema has always said actors are seeded from
      // `git config user.email` and nothing did it, which was invisible from
      // the CLI — an agent arrives with its actor — and broke the UI's solo
      // mode outright: identity resolved to "nobody" on a workspace that had
      // just been created for exactly one person. Idempotent, and a missing
      // git email is not an error.
      // The name as well as the email: bootstrapping with the email alone left
      // the person labelled by their address on every screen that shows an
      // actor, which a later `whoami` then had no reason to correct.
      const bootstrapped = await ensureHumanActor(
        handle,
        await gitConfig(layout.root, 'user.email'),
        await gitConfig(layout.root, 'user.name'),
      );
      database = {
        ready: true,
        held: false,
        detail: `PGlite provisioned and schema applied; ${bootstrapped.because}`,
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (cause) {
    // Not fatal: every file-based command still works, and the scaffold on disk
    // is valid. But it is said out loud, at the step where a user looks for
    // setup problems, instead of surfacing as a puzzling refusal later.
    //
    // Two very different situations reached this branch and were reported
    // identically, which real-world testing surfaced (2026-08-23):
    //
    //   * **Held by another process.** Somebody already has `sdlc serve` up.
    //     Nothing is wrong; the database is running, just not by us. Saying
    //     "database did not start" here is false, and failing the command
    //     would make `init` noisy on the most ordinary setup there is.
    //   * **Genuinely failed.** Missing directory, bad permissions, corrupt
    //     data dir. The scaffold is on disk and the mirror is not, and a
    //     script doing `sdlc init && sdlc verify …` must not sail past it.
    //
    // So the two are told apart, and only the second one is a failure.
    const locked = cause instanceof Error && cause.name === 'DatabaseLockedError';
    // `String(cause)` renders a non-Error throw as "[object Object]", which is
    // the least useful string a setup failure can end with. Real-world testing
    // hit exactly that.
    const because = describeCause(cause);
    database = locked
      ? { ready: false, held: true, detail: because }
      : { ready: false, held: false, detail: `database did not start: ${because}` };
  }

  return { root: layout.root, created, skipped, alreadyInitialised, initialisedGit, database };
}

/** A throw rendered for a person, whatever shape it arrived in. */
export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message;
  if (typeof cause === 'string') return cause;
  try {
    const json = JSON.stringify(cause);
    return json === undefined || json === '{}' ? String(cause) : json;
  } catch {
    return String(cause);
  }
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
      // Sync before counting. Reading the mirror as it stood made `status`
      // disagree with `list` and `queue`, which both sync first — and two
      // commands giving different answers to "how many work items are there"
      // is worse than either being slow.
      await rebuildMirror(
        resolveWorkspaceLayout(root).root,
        await PostgresStorageAdapter.create(handle.db),
      );
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

/**
 * Assigns the next free sequence for a kind.
 *
 * Reads **both** the filename and the frontmatter `id`, and takes the highest.
 * Filenames alone are not enough, and the reason is in the contracts: the `id`
 * frontmatter field is canonical (contract 02 §2.2) while the filename's
 * `-slug` is explicitly filesystem sugar that is derived once and never
 * re-derived (contract 06 §3.2). Any file whose name has drifted from its
 * `id` — an imported item, a hand-created card, one renamed by a human — is
 * invisible to a name-only scan, and the sequence then hands out an ID that
 * already exists.
 *
 * A duplicate ID in a content-in-git system is close to the worst outcome
 * available here: two files both claiming to be `FEAT-001`, with every
 * `relates_to`/`parent` reference to it now ambiguous, and nothing about the
 * moment of creation looking wrong.
 */
export async function nextSequence(kanbanDir: string, prefix: string): Promise<number> {
  const seen: number[] = [];
  const pattern = new RegExp(`^${prefix}-(\\d+)`);
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      const fromName = pattern.exec(entry.name);
      if (fromName?.[1] !== undefined) seen.push(Number.parseInt(fromName[1], 10));

      if (!entry.name.endsWith('.md')) continue;
      const raw = await fs.readFile(full, 'utf8').catch(() => '');
      const id = parseFrontmatter(raw).data['id'];
      if (typeof id !== 'string') continue;
      const fromId = pattern.exec(id);
      if (fromId?.[1] !== undefined) seen.push(Number.parseInt(fromId[1], 10));
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
    /**
     * How much of the prompt a provider can cache, and what the assembler had
     * to leave out (P1-CTX-06).
     *
     * Surfaced here because a token count alone reads as healthy right up until
     * you learn retrieval was cut to reach it. The cache figure is the number
     * that decides whether prompt caching is worth enabling at all — a boundary
     * at token 40 of a 6,000-token pack saves nothing.
     */
    readonly cacheablePrefixTokens: number;
    readonly cacheableFraction: number;
    /**
     * The stage's assembly profile (P6-PERSTAGE-01, FEAT-CTX-003).
     *
     * Surfaced, not silent. Which doc types a stage may retrieve is a decision
     * somebody made about this stage's diet, and an agent — or a person reading
     * over its shoulder — should be able to see that `implement` was denied the
     * research corpus on purpose rather than wonder why nothing came back.
     */
    readonly profile: {
      readonly stage: string;
      readonly layers: readonly string[];
      readonly docTypes: readonly string[];
      /** Hard ceiling on retrieved content for this stage (P6-PERSTAGE-02). */
      readonly retrievalBudget: number;
      readonly effortTier: string;
      readonly because: string;
    };
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
      attested = await attestItem(
        db,
        id,
        stage,
        await treeContext(layout.root),
        typeof data['verify'] === 'string' ? data['verify'] : undefined,
      );
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

  // The stage's profile, resolved once. Everything below that decides what may
  // enter the pack reads it — a second lookup would be a second answer.
  const profile = resolveStageProfile(next);
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
      // The stable prefix is the skill text: identical on every invocation of
      // this skill, and therefore the part worth a cache breakpoint.
      cacheablePrefixTokens: estimateTokens(skillStable),
      cacheableFraction:
        Math.round(
          (estimateTokens(skillStable) /
            Math.max(1, estimateTokens(`${skillStable}\n\n${cardCore}`))) *
            1000,
        ) / 1000,
      profile: {
        stage: next,
        layers: [...profile.layers],
        docTypes: [...profile.docTypes],
        retrievalBudget: profile.retrievalBudget,
        effortTier: profile.effortTier,
        because: profile.because,
      },
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

  // A repository with no commits has no HEAD, and git's own message for that
  // ("fatal: ambiguous argument 'HEAD'") tells a first-time user nothing about
  // what to do. This is the normal state of a workspace on its first day.
  if ((await git.headSha()) === '0'.repeat(40)) {
    throw new Error(
      `${layout.root} has no commits yet, so there is nothing to sync from. ` +
        'Commit the workspace first (`git add -A && git commit -m "chore: init"`), then re-run.',
    );
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

    // The card's *current* `verify:` travels with each item, so attestation can
    // tell evidence produced by this check from evidence produced by a different
    // one that has since been swapped in.
    const withCommands = await Promise.all(
      rows.map(async (row) => {
        const raw = await fs
          .readFile(path.join(layout.root, row.file_path), 'utf8')
          .catch(() => '');
        const declared = raw === '' ? undefined : parseFrontmatter(raw).data['verify'];
        return {
          id: row.id,
          lifecycleState: row.lifecycle_state,
          ...(typeof declared === 'string' ? { verifyCommand: declared } : {}),
        };
      }),
    );

    const attestations = await attestAll(db, withCommands, await treeContext(layout.root));
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
  /** Where the retired capture went, so it can still be read. */
  readonly archivedTo?: string;
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

  // The capture is retired, not left lying about. It was previously kept in
  // place with `kind: capture`, which the work-item validator rejects — so every
  // `db:rebuild` from then on reported `failed: 1` on a file the tool itself had
  // created and then abandoned. A permanent, self-inflicted error is worse than
  // either deleting it or keeping it valid.
  //
  // Moved rather than deleted: the original wording is often the only record of
  // what was actually meant, and `_archive/` is outside the tree the mirror
  // walks, so it stops being ingested without ceasing to exist.
  const archiveDir = path.join(layout.root, '.sdlcof', 'archive', 'captures');
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.rename(found.filePath, path.join(archiveDir, path.basename(found.filePath)));

  return {
    capturedId,
    workItemId: id,
    filePath: path.relative(layout.root, filePath),
    kind,
    archivedTo: path.relative(layout.root, path.join(archiveDir, path.basename(found.filePath))),
  };
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
      if (held === null) {
        // "already held by (unknown)" for an id that does not exist sent a blind
        // evaluator looking for a phantom claimant. Two different failures need
        // two different messages.
        const known = await db.query<{ id: string }>('SELECT id FROM work_items WHERE id = $1;', [
          id,
        ]);
        if (known.length === 0) {
          throw new Error(
            `no work item with id "${id}" — check \`sdlc list\` for the ids that exist`,
          );
        }
      }
      return {
        workItemId: id,
        claimedBy: actor,
        leaseExpiresAt: '',
        granted: false,
        heldBy: held?.claimedBy ?? '(the lease could not be taken)',
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
   * What the declared focus actually requires, and where each requirement came
   * from (P1-LIFE-06, ADR-0054).
   *
   * Shown with attribution because a required set with no provenance cannot be
   * argued with: nobody can tell a check the baseline demands from one the
   * declaration added, so nobody can tell whether lowering the declaration would
   * remove it. Making that legible is the point of the whole feature — "we
   * hardened the important part" has to be visible as required evidence rather
   * than as an intention.
   */
  readonly requiredChecks: readonly { readonly kind: string; readonly because: string }[];
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
    requiredChecks: explainRequiredChecks(config?.focus ?? FocusProfileSchema.parse({})).map(
      (entry) => ({ kind: entry.kind, because: entry.dimension }),
    ),
    inert: inertCapabilities(advanced).map((entry) => ({
      key: entry.key,
      lands_in: entry.implementedBy ?? '(unscheduled)',
    })),
  };
}

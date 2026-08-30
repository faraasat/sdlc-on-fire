import path from 'node:path';
import { z } from 'zod';
import { AdvancedConfigSchema } from './capabilities.js';
import { FocusProfileSchema } from './focus.js';
import { SandboxConfigSchema } from './sandbox.js';
import { TierPolicyConfigSchema, tierPolicyViolations } from './tier-policy.js';

/**
 * Canonical workspace layout and config schema, per
 * contracts/06-workspace-layout.md and ADR-0043.
 *
 * The layout is **data, not code**: `init` scaffolds from these constants and
 * the daemon resolves against them, so there is one place that knows where
 * things live. This module deliberately holds no filesystem side effects —
 * scaffolding is `P0-CLI-03` — which keeps it safe to import from a `status`
 * read on a workspace that was never initialised.
 */

/**
 * The root file whitelist (ADR-0043). `init` emits exactly these and nothing
 * else; a project's own extra root files are left untouched but never treated as
 * SDLC on Fire assets.
 */
/**
 * The root files a workspace needs in order to *operate* (P5-PILOT-02).
 *
 * `SDLCOF.md` is the tool's own note about this project; `CLAUDE.md` and
 * `AGENTS.md` are what a coding agent reads before touching anything. Without
 * these three the product does not work. Everything else in `ROOT_FILES` is a
 * document a team benefits from having and can be written whenever they want
 * one.
 *
 * The distinction exists because of the hono pilot: `init` put seven markdown
 * files at the root of a project with its own established conventions, and
 * twenty-one into a curated `docs/` that had three. Nothing was overwritten —
 * the invariant held — and it is still a large front door for one tool, in
 * exactly the situation where a maintainer is deciding whether to keep it.
 */
export const ESSENTIAL_ROOT_FILES = ['AGENTS.md', 'CLAUDE.md', 'SDLCOF.md'] as const;

export const ROOT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md',
  'SOUL.md',
  'DESIGN.md',
  'SDLCOF.md',
  'TOOLS.md',
] as const;

/** Topic files generated at the root of `docs/`. */
export const DOCS_ROOT_FILES = [
  'README.md',
  'DESIGN.md',
  'UI.md',
  'HOWTO.md',
  'SECURITY.md',
  'TESTING.md',
  'AUDIT.md',
  'SCALING.md',
  'MAINTAINABILITY.md',
  'ARCHITECTURE.md',
  'FEATURES.md',
  'SOUL.md',
  'HISTORY.md',
  'CHANGELOG.md',
  'DECISION.md',
  'VERIFICATION.md',
  'UAT.md',
] as const;

/**
 * Directories created eagerly at `init`.
 *
 * `docs/.research/<tech>/` and the per-initiative `docs/.plan/plan-…` folders are
 * deliberately absent —
 * contract §7 creates those lazily, when a research pass or an initiative
 * actually runs, rather than pre-creating folders for a stack nobody has chosen.
 */
export const EAGER_DIRECTORIES = [
  'kanban/_inbox',
  'kanban/epics',
  'docs/architectural-design-decisions',
  // Where a stage hands off to a human or to the next initiative (ADR-0050,
  // contracts/06). Created eagerly because a handoff written into a directory
  // that does not exist yet gets written somewhere else instead.
  'docs/handoff',
  // Gate policies are content (contract 03 §4, contract 06 §2), so they are
  // created eagerly and tracked — a governance rule git never sees is one
  // nobody reviewed.
  'docs/gates',
  'docs/assets/screenshots',
] as const;

/**
 * Folders whose README is scaffolded, per ADR-0053's index-first rule.
 *
 * A folder without one is a folder an agent has to scan, which is the cost the
 * rule exists to avoid — and an index nobody created at `init` is one nobody
 * creates later either.
 */
export const INDEXED_DIRECTORIES: Readonly<Record<string, string>> = {
  'docs/architectural-design-decisions':
    '# Architectural decisions\n\nGlobal, cross-cutting decisions that shape the whole project.\n' +
    'One decision per file, `ADR-NNNN-slug.md`, listed here.\n\n' +
    'A decision that constrains work **outside** its initiative belongs here. One that\n' +
    "binds a single epic belongs in that initiative's `decisions/`, and is promoted here\n" +
    'by a superseding global ADR if its scope grows (ADR-0050).\n\n| ADR | Title |\n|---|---|\n',
  'docs/gates':
    '# Gate policies\n\nOne YAML file per policy, `<name>.yaml`, compiled into `gate_policies` by\n' +
    '`sdlc gates list` (contract 03 §4, ADR-0005). Content, not machine state: these are\n' +
    'hand-edited, diffed and reviewed in a PR, which is the whole reason they live here\n' +
    'rather than in the hidden state directory.\n\n' +
    'A project with no policy files is **ungated**, not passing — every transition goes\n' +
    'through, and `sdlc gates list` says so rather than reporting a clean run.\n\n' +
    '```yaml\nname: standard\napplies_to: { work_type: ["*"], risk_level: ["*"], path_pattern: ["**"] }\n' +
    'transition: "build -> review"\nevidence:\n  - { kind: test, required: true }\n' +
    'approvals: { required_roles: [], min_approvals: 0 }\noverridable_by: ["eng-lead"]\n```\n\n' +
    '`overridable_by: []` is a **closed door**, not an unset field: it means there is no\n' +
    'override path for this gate at all.\n',
  'docs/handoff':
    '# Handoffs\n\nWhat one stage or initiative handed the next: decisions made, questions\n' +
    'still open, and what the next stage needs. Structured rather than prose, so\n' +
    'nothing is silently dropped between stages (ADR-0021).\n',
};

/** Files a per-initiative plan folder gets (contracts/06, ADR-0049/0050). */
export const INITIATIVE_FILES: Readonly<Record<string, string>> = {
  'README.md': '# {title}\n\nOne paragraph on what this initiative is for, and what it is not.\n',
  'qna.md':
    '# Q&A\n\nThe requirement echo-back exchange: what the agent understood, what it\n' +
    'asked, and what the human answered (ADR-0049).\n',
  'human-loop.md':
    '# Human loop\n\nEvery decision a human made on this initiative, with who and when.\n',
  'VERIFICATION.md':
    '# Verification\n\nHow this initiative was checked, with the commands that were actually\n' +
    'run and their output. A claim that something passed is not an entry here.\n',
  'UAT.md':
    '# UAT\n\nWhat a person tried, in their own words, and what happened. Kept separate\n' +
    'from VERIFICATION.md because a passing suite and a satisfied user are\n' +
    'different claims, and one has never implied the other.\n',
};

/** State-dir subdirectories created at `init`. `cache/` and `locks/` are lazy (contract §7). */
export const EAGER_STATE_SUBDIRS = ['db', 'logs'] as const;

export const DEFAULT_KANBAN_DIR = 'kanban';
export const DEFAULT_DOCS_DIR = 'docs';
export const DEFAULT_STATE_DIR = '.sdlcof';

/**
 * Everything under the hidden state dir is machine-only and rebuildable
 * (ADR-0006): the DB is a mirror, the caches are derived, and the logs are
 * local. Ignoring the directory wholesale is what makes `db:rebuild` safe.
 */
export const GITIGNORE_ENTRIES = [`/${DEFAULT_STATE_DIR}/`] as const;

/** How the workspace reaches its database (ADR-0068). */
export const DATABASE_MODES = ['pglite', 'connected'] as const;
export const DatabaseModeSchema = z.enum(DATABASE_MODES);
export type DatabaseMode = z.infer<typeof DatabaseModeSchema>;

export const WorkspaceConfigSchema = z
  .object({
    $schema: z.url().optional(),
    paths: z
      .object({
        kanban: z.string().min(1).default(DEFAULT_KANBAN_DIR),
        docs: z.string().min(1).default(DEFAULT_DOCS_DIR),
        state_dir: z.string().min(1).default(DEFAULT_STATE_DIR),
      })
      .prefault({}),
    docs: z
      .object({
        /**
         * Which `docs/` root topic files to generate. Defaults to all of
         * {@link DOCS_ROOT_FILES}; narrow it to skip files a project does not
         * need (e.g. `UI.md` on a CLI-only project).
         *
         * Suppressing *generation* never suppresses the doc-governance rule
         * (ADR-0046) for files that do exist.
         */
        generate: z.array(z.enum(DOCS_ROOT_FILES)).optional(),
      })
      .prefault({}),
    /**
     * Whether this workspace is one person or a team (P3-RBAC-03).
     *
     * Decides what happens to an approval rule nobody but the author could
     * satisfy: `solo` auto-satisfies it — loudly, on the verdict — because the
     * alternative is a board that can never advance; `team` deadlocks and names
     * the missing role, because in a team an unsatisfiable rule means the
     * roster is wrong and passing it silently is how a review requirement
     * becomes decorative.
     *
     * **Declared, never inferred.** Deriving it from the roster would flip the
     * mode the day somebody is added or goes on leave — a two-person team with
     * one person away is still a team, and inferring would drop the review
     * requirement exactly when it matters.
     */
    mode: z.enum(['solo', 'team']).default('solo'),
    /** Advanced capabilities, every one default-off (ADR-0067, P0-OBJ-04). */
    advanced: AdvancedConfigSchema,
    /** Intake behaviour — the echo-back gate's right-sizing knob (ADR-0049). */
    intake: z
      .object({
        /**
         * Let an unambiguous restatement with no questions proceed unapproved.
         *
         * Off by default, and the default is the decision: turning it on is the
         * user saying which asks are not worth their attention. On by default
         * would be the agent deciding when it needs supervision.
         */
        autoApproveUnambiguous: z.boolean().default(false),
      })
      .prefault({}),
    /**
     * OS-level confinement of the shell-exec path (ADR-0036, P1-SEC-02).
     *
     * Off by default. A sandbox is a real change to how commands run, and
     * enabling one silently would break toolchains in ways that look like the
     * code is broken rather than the sandbox.
     */
    sandbox: SandboxConfigSchema,
    /**
     * Tier → model routing (ADR-0028, P1-AGENT-08).
     *
     * The one place a model id appears. That was already the *rule*; until this
     * section existed it was only true of the type, since every caller passed a
     * hardcoded literal.
     */
    agents: TierPolicyConfigSchema,
    database: z
      .object({
        mode: DatabaseModeSchema.default('pglite'),
        /** Connection string; required in connected mode, meaningless in PGlite mode. */
        url: z.string().min(1).optional(),
      })
      .prefault({}),
    preset: z.enum(['lite', 'standard', 'strict']).default('standard'),
    /**
     * Where this project's value and risk concentrate (ADR-0054, P1-LIFE-06).
     *
     * Optional: an undeclared project gets the balanced baseline. Inferring a
     * focus from the code would be a model judgement in a decision path, which
     * ADR-0040 rules out — and the floors mean declaring nothing is never the
     * unsafe choice.
     */
    focus: FocusProfileSchema,
  })
  .superRefine((config, ctx) => {
    // Reported at config-parse time, not at dispatch: a policy error discovered
    // mid-run has already spent tokens getting there.
    for (const problem of tierPolicyViolations(config.agents)) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: problem });
    }

    // Connected mode with no endpoint is a workspace that cannot start. Catching
    // it here beats a confusing connection failure at first query.
    if (config.database.mode === 'connected' && config.database.url === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['database', 'url'],
        message: 'database.url is required when database.mode is "connected"',
      });
    }

    // A path knob that escapes the project root would put managed content
    // outside the repo, breaking the content-in-git invariant.
    for (const key of ['kanban', 'docs', 'state_dir'] as const) {
      const value = config.paths[key];
      if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
        ctx.addIssue({
          code: 'custom',
          path: ['paths', key],
          message: `paths.${key} must be a relative path inside the project root`,
        });
      }
    }
  });

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/** Resolved absolute locations for one workspace. */
export interface WorkspaceLayout {
  readonly root: string;
  readonly kanbanDir: string;
  readonly docsDir: string;
  /** Gate-policy YAML (contract 03 §4, contract 06 §2) — content, so under `docs/`. */
  readonly gatesDir: string;
  /**
   * Saved board views (P4-COLLAB-03, contract 06 §2a).
   *
   * Beside `gatesDir` and for the same reason: a saved view is authored,
   * shared and reviewed, so it is content and cannot live under the gitignored
   * `.sdlcof/`.
   */
  readonly viewsDir: string;
  /**
   * Local prompt overlays (P6-SURFACE-08, FEAT-AGT-009).
   *
   * Beside `gatesDir` and `viewsDir`, for the reason those two are there: an
   * overlay is authored by a person, shared with a team, diffed when it
   * changes, and must survive `db:rebuild`. That is content, so it cannot live
   * under the gitignored state dir, and the root whitelist rules out a new
   * top-level folder.
   */
  readonly promptsDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly lockDir: string;
  readonly cacheDir: string;
  readonly logDir: string;
  readonly configPath: string;
}

/**
 * Resolves a workspace's absolute paths. Pure — creates nothing, reads nothing.
 *
 * Accepts a partial config so callers can resolve paths before a config file
 * exists, which is exactly the situation `init` is in.
 */
export function resolveWorkspaceLayout(
  root: string,
  paths?: Partial<WorkspaceConfig['paths']>,
): WorkspaceLayout {
  const absoluteRoot = path.resolve(root);
  const stateDir = path.join(absoluteRoot, paths?.state_dir ?? DEFAULT_STATE_DIR);

  return {
    root: absoluteRoot,
    kanbanDir: path.join(absoluteRoot, paths?.kanban ?? DEFAULT_KANBAN_DIR),
    docsDir: path.join(absoluteRoot, paths?.docs ?? DEFAULT_DOCS_DIR),
    gatesDir: path.join(absoluteRoot, paths?.docs ?? DEFAULT_DOCS_DIR, 'gates'),
    viewsDir: path.join(absoluteRoot, paths?.docs ?? DEFAULT_DOCS_DIR, 'views'),
    promptsDir: path.join(absoluteRoot, paths?.docs ?? DEFAULT_DOCS_DIR, 'prompts'),
    stateDir,
    dataDir: path.join(stateDir, 'db'),
    lockDir: path.join(stateDir, 'locks'),
    cacheDir: path.join(stateDir, 'cache'),
    logDir: path.join(stateDir, 'logs'),
    configPath: path.join(stateDir, 'config.yaml'),
  };
}

/** The `docs/` root files a given config asks for, in canonical order. */
export function docsToGenerate(config: WorkspaceConfig): readonly string[] {
  const requested = config.docs.generate;
  if (requested === undefined) return DOCS_ROOT_FILES;
  const wanted = new Set<string>(requested);
  // Filtered from the canonical list rather than returned as given, so config
  // order never leaks into the generated tree.
  return DOCS_ROOT_FILES.filter((file) => wanted.has(file));
}

/**
 * Whether a repo-relative path is workspace content the tool manages.
 *
 * The hidden state dir is excluded deliberately: it is machine state, gitignored
 * in full, and must never be treated as content to sync.
 */
export function isManagedContentPath(
  relativePath: string,
  paths?: Partial<WorkspaceConfig['paths']>,
): boolean {
  const normalised = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const kanban = `${paths?.kanban ?? DEFAULT_KANBAN_DIR}/`;
  const docs = `${paths?.docs ?? DEFAULT_DOCS_DIR}/`;
  return normalised.startsWith(kanban) || normalised.startsWith(docs);
}

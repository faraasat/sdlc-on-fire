import path from 'node:path';
import { z } from 'zod';
import { AdvancedConfigSchema } from './capabilities.js';

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
  'docs/assets/screenshots',
] as const;

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
    /** Advanced capabilities, every one default-off (ADR-0067, P0-OBJ-04). */
    advanced: AdvancedConfigSchema,
    database: z
      .object({
        mode: DatabaseModeSchema.default('pglite'),
        /** Connection string; required in connected mode, meaningless in PGlite mode. */
        url: z.string().min(1).optional(),
      })
      .prefault({}),
    preset: z.enum(['lite', 'standard', 'strict']).default('standard'),
  })
  .superRefine((config, ctx) => {
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

import path from 'node:path';

/**
 * Machine-state paths inside a managed workspace, per
 * contracts/06-workspace-layout.md §2.
 *
 * `.sdlcof/` is hidden and gitignored in full — nothing under it is content, and
 * everything under it is reconstructible. `db/` in particular is destroyed and
 * rebuilt by `db:rebuild` (ADR-0006), which is only safe because git holds the
 * content and the DB holds a mirror.
 */

/** The hidden machine-state directory name. Overridable per workspace in config. */
export const DEFAULT_STATE_DIR = '.sdlcof';

export interface WorkspacePaths {
  /** Workspace root — the directory holding `.sdlcof/`. */
  readonly root: string;
  /** `.sdlcof/` itself. */
  readonly stateDir: string;
  /** `.sdlcof/db/` — the PGlite data directory. Empty in connected mode (ADR-0068). */
  readonly dataDir: string;
  /** `.sdlcof/locks/` — local single-instance daemon lock, never the authoritative claim record. */
  readonly lockDir: string;
  /** `.sdlcof/logs/`. */
  readonly logDir: string;
}

/**
 * Resolves the machine-state paths for a workspace. Pure — creates nothing.
 * Provisioning is what creates directories, so path resolution stays safe to call
 * from anywhere, including a `--json` status read on a workspace that has never
 * been initialised.
 */
export function resolveWorkspacePaths(
  root: string,
  stateDirName = DEFAULT_STATE_DIR,
): WorkspacePaths {
  const absoluteRoot = path.resolve(root);
  const stateDir = path.join(absoluteRoot, stateDirName);
  return {
    root: absoluteRoot,
    stateDir,
    dataDir: path.join(stateDir, 'db'),
    lockDir: path.join(stateDir, 'locks'),
    logDir: path.join(stateDir, 'logs'),
  };
}

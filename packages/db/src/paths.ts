import { resolveWorkspaceLayout, type WorkspaceLayout } from '@sdlc-on-fire/core';

/**
 * Machine-state paths for the DB adapter.
 *
 * The layout itself is owned by `@sdlc-on-fire/core` (contracts/06) — this is a
 * re-export so the adapter has one obvious import, not a second definition.
 * Duplicating the path constants here is exactly how `.sdlcof/db` and
 * `.sdlcof/database` end up both existing.
 */

export { DEFAULT_STATE_DIR } from '@sdlc-on-fire/core';
export type { WorkspaceLayout } from '@sdlc-on-fire/core';

/** @deprecated Prefer {@link resolveWorkspaceLayout} from `@sdlc-on-fire/core` directly. */
export function resolveWorkspacePaths(root: string, stateDirName?: string): WorkspaceLayout {
  return resolveWorkspaceLayout(
    root,
    stateDirName === undefined ? undefined : { state_dir: stateDirName },
  );
}

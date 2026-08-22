/**
 * Saved board views (P4-COLLAB-03, contract 06 §2a).
 *
 * A named filter + grouping + view-mode, optionally scoped to a role. The
 * board projection already accepts every one of those as an argument, so a
 * saved view is not a new way to build a board — it is a *stored argument
 * list*. That distinction is the whole design. A second projection path would
 * eventually disagree with the first about what "blocked" means, and the two
 * would be reconciled by whichever one someone happened to be looking at.
 *
 * **A view is content, not state.** It is authored by a person, shared with a
 * team, diffed when it changes, and must survive `db:rebuild` — so it lives in
 * `docs/views/` as YAML and the database caches nothing about it. The parsing
 * here is deliberately separate from the reading: `parseViewDefinition` takes an
 * already-decoded object, so every rule below is testable without a filesystem.
 *
 * **Related to, and not the same as, `board.ts`'s `SavedView`.** That type is
 * the *URL-shareable* triple — name, grouping, filter — encoded into a link so
 * "the board I am looking at" can be pasted to somebody. This is the *persisted*
 * definition: a file with an identity, a role scope and a description. A
 * `ViewDefinition` extends `SavedView`, so `encodeView` takes one directly and a
 * stored view becomes a link with no conversion step. Two names because they are
 * two lifetimes; one shape because they describe the same board.
 *
 * **Role scoping selects, it does not authorise.** A view scoped to `security`
 * is a view that is *useful* to that role, not one that is restricted to it.
 * Nothing here is a permission boundary, and it is worth saying so explicitly
 * in the type's own documentation: a future reader looking for access control
 * must not find this and think they have it. Permissions live in the
 * capability model and are enforced server-side.
 */

import { GROUP_BY, type BoardFilter, type GroupBy, type SavedView } from './board.js';
import { ROLE_KEYS, type RoleKey } from './capability.js';

/** Which surface a view opens in. Mirrors the UI's view modes. */
export const VIEW_MODES = ['board', 'table', 'roadmap', 'metrics'] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export interface ViewDefinition extends SavedView {
  /** Filename-derived, unique within the workspace. */
  readonly slug: string;
  readonly mode: ViewMode;
  /** The role this view is *for*. Selection, never authorisation. */
  readonly role: RoleKey | null;
  readonly description: string | null;
}

/** One reason a view file could not be used, with the field that caused it. */
export interface ViewProblem {
  readonly field: string;
  readonly because: string;
}

export interface ParsedViewDefinition {
  readonly view: ViewDefinition | null;
  readonly problems: readonly ViewProblem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Turn a decoded YAML object into a view, or into the reasons it is not one.
 *
 * Every unknown value is a *problem*, never a silent default. A view file with
 * `mode: bord` that quietly opened the board would be indistinguishable from
 * one that was spelled correctly, and the author would never learn that the
 * file they are maintaining does nothing. The one exception is an absent
 * optional field, which is not a mistake.
 */
export function parseViewDefinition(slug: string, raw: unknown): ParsedViewDefinition {
  const problems: ViewProblem[] = [];
  if (!isRecord(raw)) {
    return { view: null, problems: [{ field: '(file)', because: 'not a YAML mapping' }] };
  }

  const name = typeof raw['name'] === 'string' && raw['name'].trim() !== '' ? raw['name'] : null;
  if (name === null) problems.push({ field: 'name', because: 'required, and must be non-empty' });

  const modeRaw = raw['mode'] ?? 'board';
  const mode = (VIEW_MODES as readonly unknown[]).includes(modeRaw) ? (modeRaw as ViewMode) : null;
  if (mode === null) {
    problems.push({ field: 'mode', because: `must be one of ${VIEW_MODES.join(', ')}` });
  }

  const groupRaw = raw['groupBy'] ?? 'none';
  const groupBy = (GROUP_BY as readonly unknown[]).includes(groupRaw)
    ? (groupRaw as GroupBy)
    : null;
  if (groupBy === null) {
    problems.push({ field: 'groupBy', because: `must be one of ${GROUP_BY.join(', ')}` });
  }

  let role: RoleKey | null = null;
  if (raw['role'] !== undefined && raw['role'] !== null) {
    if ((ROLE_KEYS as readonly unknown[]).includes(raw['role'])) role = raw['role'] as RoleKey;
    else problems.push({ field: 'role', because: `must be one of ${ROLE_KEYS.join(', ')}` });
  }

  const filterRaw = raw['filter'] ?? {};
  const filter: Record<string, unknown> = {};
  if (!isRecord(filterRaw)) {
    problems.push({ field: 'filter', because: 'must be a mapping' });
  } else {
    for (const [key, value] of Object.entries(filterRaw)) {
      switch (key) {
        case 'text':
        case 'risk':
          if (value === null || typeof value === 'string') filter[key] = value;
          else problems.push({ field: `filter.${key}`, because: 'must be a string or null' });
          break;
        case 'blockedOnly':
        case 'needsHumanOnly':
          if (typeof value === 'boolean') filter[key] = value;
          else problems.push({ field: `filter.${key}`, because: 'must be true or false' });
          break;
        default:
          // Named rather than ignored. A typo'd filter key silently dropped is
          // a view that shows more cards than its author believes it does.
          problems.push({ field: `filter.${key}`, because: 'not a known filter' });
      }
    }
  }

  if (problems.length > 0) return { view: null, problems };

  return {
    view: {
      slug,
      name: name as string,
      mode: mode as ViewMode,
      groupBy: groupBy as GroupBy,
      filter,
      role,
      description: typeof raw['description'] === 'string' ? raw['description'] : null,
    },
    problems: [],
  };
}

/**
 * Views a given role should be offered, newest-agnostic and stable.
 *
 * Unscoped views are included for every role, because a view with no `role` is
 * a view for everybody rather than a view for nobody. Sorted by name so a
 * picker does not reorder itself when a file is added.
 */
export function viewsForRole(
  views: readonly ViewDefinition[],
  role: RoleKey | null,
): readonly ViewDefinition[] {
  return [...views]
    .filter((view) => view.role === null || view.role === role)
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

/** The projection arguments a view stands for. Applied by the same code any board uses. */
export function viewOptions(view: ViewDefinition): { groupBy: GroupBy; filter: BoardFilter } {
  return { groupBy: view.groupBy, filter: view.filter };
}

/**
 * A slug from a filename.
 *
 * Lowercased and stripped of the extension only. Deliberately not a general
 * slugifier: the filename *is* the identity, and rewriting it here would mean
 * two files could collapse to one slug and the second would silently replace
 * the first.
 */
export function slugFromFilename(filename: string): string {
  return filename.replace(/\.(ya?ml)$/i, '').toLowerCase();
}

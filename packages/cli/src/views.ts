import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseViewDefinition,
  relativePosix,
  resolveWorkspaceLayout,
  slugFromFilename,
  viewsForRole,
  type RoleKey,
  type ViewDefinition,
  type ViewProblem,
} from '@sdlc-on-fire/core';

/**
 * `sdlc views` — reading the saved views in `docs/views/` (P4-COLLAB-03).
 *
 * Shaped after `gates.ts` deliberately, because the two files answer the same
 * question about the same kind of artifact: a YAML document under `docs/` that
 * a person authored and a machine must not silently misread.
 *
 * The one difference is what a bad file costs. A gate policy that fails to load
 * leaves a gate silently not gating, so `gates list` exits non-zero. A view
 * that fails to load costs a menu entry — so this reports the problem loudly
 * and still returns the views that *did* load, because refusing to show any
 * view because one file has a typo helps nobody.
 */

export interface ViewFileProblem extends ViewProblem {
  readonly file: string;
}

export interface ViewsResult {
  readonly views: readonly ViewDefinition[];
  readonly problems: readonly ViewFileProblem[];
  readonly dir: string;
  readonly ok: boolean;
}

/** Load every view file, reporting per-file problems rather than throwing. */
export async function readViews(root: string): Promise<ViewsResult> {
  const layout = resolveWorkspaceLayout(root);
  const entries = await fs.readdir(layout.viewsDir, { withFileTypes: true }).catch(() => []);
  const views: ViewDefinition[] = [];
  const problems: ViewFileProblem[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const full = path.join(layout.viewsDir, entry.name);
    const file = relativePosix(layout.root, full);

    let value: unknown;
    try {
      value = parseYaml(await fs.readFile(full, 'utf8'));
    } catch (cause) {
      // A syntax error is a file that failed to load, not a file that was not
      // there. Same path as a schema failure so the two cannot be confused.
      problems.push({
        file,
        field: '(yaml)',
        because: String(cause).split('\n')[0] ?? 'unparseable',
      });
      continue;
    }

    const slug = slugFromFilename(entry.name);
    const duplicate = views.some((view) => view.slug === slug);
    if (duplicate) {
      // Two files cannot claim one slug. Reported rather than last-wins, which
      // would make which view you get depend on directory order.
      problems.push({ file, field: 'slug', because: `duplicate slug "${slug}"` });
      continue;
    }

    const parsed = parseViewDefinition(slug, value);
    if (parsed.view === null) {
      for (const problem of parsed.problems) problems.push({ ...problem, file });
    } else views.push(parsed.view);
  }

  return {
    views,
    problems,
    dir: relativePosix(layout.root, layout.viewsDir),
    ok: problems.length === 0,
  };
}

/**
 * The views a role should be offered, from disk.
 *
 * `role` distinguishes three cases, and collapsing any two of them is a bug
 * this had before a test caught it:
 *
 *   * `undefined` — no role was asked for, so do not filter. Every view.
 *   * `null` — a person with no role. Unscoped views only.
 *   * a `RoleKey` — that role's views, plus the unscoped ones.
 *
 * The middle and the first look identical in a signature typed `RoleKey | null`,
 * and the symptom is a `sdlc views` that silently hides every role-scoped view
 * from someone who did not pass a flag.
 */
export async function listViews(root: string, role?: RoleKey | null): Promise<ViewsResult> {
  const result = await readViews(root);
  if (role === undefined) return result;
  return { ...result, views: viewsForRole(result.views, role) };
}

export function formatViews(result: ViewsResult): string {
  const lines: string[] = [];

  if (result.views.length === 0 && result.problems.length === 0) {
    return `No saved views in ${result.dir}/. Add a YAML file there to create one.`;
  }

  for (const view of result.views) {
    const scope = view.role === null ? 'everyone' : view.role;
    lines.push(`  ${view.slug}  ${view.name}  [${view.mode}, ${scope}]`);
    if (view.description !== null) lines.push(`      ${view.description}`);
  }

  if (result.problems.length > 0) {
    lines.push('');
    // Named per file and per field. "One view failed to load" sends someone
    // reading four files to find which.
    lines.push(`${String(result.problems.length)} problem(s) — these files were not loaded:`);
    for (const problem of result.problems) {
      lines.push(`  ${problem.file}: ${problem.field} — ${problem.because}`);
    }
  }

  return lines.join('\n');
}

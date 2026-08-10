import { buildBranchName, createGitManager, type BranchType } from '@sdlc-on-fire/daemon';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { rebuildMirror } from '@sdlc-on-fire/daemon';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc branch` — the branch name, derived rather than invented (P1-GIT-03,
 * ADR-0048).
 *
 * Two things had shipped and could not be reached from anywhere: `buildBranchName`
 * computed `<type>/<epic>-<feature>-<task-id>-<slug>` and nothing called it, and
 * `work_items.parent_id` had a column *and an index* that nothing ever wrote to.
 * The hierarchy the branch name encodes was therefore unavailable to the one
 * function whose whole job was encoding it.
 *
 * The claim check is the other half of ADR-0048. A branch is where work happens,
 * so creating one is the moment to ask whether this work is actually yours —
 * asking later, at commit or PR time, means asking after the duplicated effort
 * has already been spent.
 */

/** Conventional-commit type implied by the item's kind. */
const TYPE_FOR_KIND: Readonly<Record<string, BranchType>> = {
  bug: 'fix',
  epic: 'feat',
  feature: 'feat',
  story: 'feat',
  task: 'feat',
};

export interface BranchResult {
  readonly workItemId: string;
  readonly branch: string;
  /** Ancestors found, outermost first — what the name's segments came from. */
  readonly hierarchy: readonly { readonly id: string; readonly kind: string }[];
  readonly created: boolean;
  /** Why it was refused, when it was. */
  readonly refusal?: string | undefined;
}

interface Row {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly parent_id: string | null;
}

/**
 * Walks parent links to the root, outermost ancestor first.
 *
 * Cycle-guarded. `parent_id` is a plain frontmatter field a human can edit, so
 * `A → B → A` is a typo away, and a walk that trusted the data would hang rather
 * than report the problem.
 */
export async function ancestorsOf(
  db: { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> },
  id: string,
): Promise<Row[]> {
  const chain: Row[] = [];
  const seen = new Set<string>([id]);
  let current: string | null = id;

  while (current !== null) {
    const rows: Row[] = await db.query<Row>(
      'SELECT id, type, title, parent_id FROM work_items WHERE id = $1;',
      [current],
    );
    const row = rows[0];
    if (row === undefined) break;
    if (row.id !== id) chain.unshift(row);
    current = row.parent_id;
    if (current !== null && seen.has(current)) {
      throw new Error(
        `parent chain for ${id} cycles at ${current} — a work item cannot be its own ancestor. ` +
          'Fix `parent_id` on one of the cards in the loop.',
      );
    }
    if (current !== null) seen.add(current);
  }
  return chain;
}

export async function branchFor(
  root: string,
  id: string,
  options: { actor?: string | undefined; create?: boolean | undefined } = {},
): Promise<BranchResult> {
  const layout = resolveWorkspaceLayout(root);
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await rebuildMirror(layout.root, port);

    const rows = await db.query<Row>(
      'SELECT id, type, title, parent_id FROM work_items WHERE id = $1;',
      [id],
    );
    const item = rows[0];
    if (item === undefined) throw new Error(`no work item with id "${id}" in the mirror`);

    const chain = await ancestorsOf(db, id);
    const epic = chain.find((row) => row.type === 'epic')?.title;
    const feature = chain.find((row) => row.type === 'feature' || row.type === 'story')?.title;

    const branch = buildBranchName({
      type: TYPE_FOR_KIND[item.type] ?? 'chore',
      ...(epic === undefined ? {} : { epic }),
      ...(feature === undefined ? {} : { feature }),
      taskId: item.id,
      slug: item.title,
    });

    const hierarchy = chain.map((row) => ({ id: row.id, kind: row.type }));
    if (options.create !== true) return { workItemId: id, branch, hierarchy, created: false };

    // ADR-0048: claim before you start. Checked against the *current* holder, not
    // against whether a claim exists — an expired lease held by someone else is
    // not a claim, and a claim held by someone else is not yours.
    const held = await port.claimOf(id);
    if (options.actor === undefined) {
      return {
        workItemId: id,
        branch,
        hierarchy,
        created: false,
        refusal: `--actor is required to create a branch: ${id} must be claimed before work starts (ADR-0048)`,
      };
    }
    if (held === null || held.claimedBy !== options.actor) {
      return {
        workItemId: id,
        branch,
        hierarchy,
        created: false,
        refusal:
          held === null
            ? `${id} is not claimed — run \`sdlc claim ${id} --actor ${options.actor}\` first`
            : `${id} is claimed by "${held.claimedBy}", not by "${options.actor}"`,
      };
    }

    const git = createGitManager({ repoRoot: layout.root });
    if (!(await git.isRepo())) {
      return {
        workItemId: id,
        branch,
        hierarchy,
        created: false,
        refusal: `${layout.root} is not a git repository — run \`git init\` first`,
      };
    }
    if ((await git.listBranches()).includes(branch)) {
      return {
        workItemId: id,
        branch,
        hierarchy,
        created: false,
        refusal: `${branch} already exists`,
      };
    }
    await git.createBranch(branch);
    return { workItemId: id, branch, hierarchy, created: true };
  } finally {
    await db.close();
  }
}

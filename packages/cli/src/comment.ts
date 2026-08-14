import {
  AuthorRoleSchema,
  CommentSchema,
  CommentTypeSchema,
  resolveWorkspaceLayout,
  type Comment,
  type CommentType,
} from '@sdlc-on-fire/core';
import { renderCommentDirectives, type DirectiveAudience } from '@sdlc-on-fire/context';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';
import { resolveAuthor } from './access.js';

/**
 * `sdlc comment` — posting a typed comment (P1-CMT-02, ADR-0012/0016).
 *
 * The effect is computed **here**, at insert, from the type and the author's
 * role, and written to a column a trigger refuses to change. That ordering is
 * the whole security property: by the time any agent sees a comment, what it is
 * for has already been decided by something that never read its body.
 *
 * Steering an in-flight run works by arriving in time for the *next* pack. There
 * is deliberately no path from here into a running agent's context (ADR-0016) —
 * that channel is what this design exists to not build.
 */

/**
 * The effect for a `(type × role)` pair, from the seeded dispatch.
 *
 * A missing row is a refusal, not a default. The table is seeded total — every
 * type against every role and against no role — so a hole in it means the
 * database was not seeded or somebody deleted a rule, and picking a value here
 * would turn either of those into a silently different security decision.
 */
export async function dispatchedEffect(
  db: { query<T>(sql: string, params?: unknown[]): Promise<T[]> },
  type: CommentType,
  role: string | null,
): Promise<string> {
  const rows = await db.query<{ role_effect: string }>(
    `SELECT role_effect FROM comment_role_effects
      WHERE comment_type = $1 AND role_key IS NOT DISTINCT FROM $2;`,
    [type, role],
  );
  const effect = rows[0]?.role_effect;
  if (effect === undefined) {
    throw new Error(
      `no dispatch row for (${type}, ${role ?? 'no role'}) — the table is seeded total, so a ` +
        'missing rule means an unseeded database rather than an undecided case (ADR-0012); ' +
        'run `sdlc db:up`',
    );
  }
  return effect;
}

export interface PostedComment {
  readonly id: number;
  readonly workItemId: string;
  readonly type: CommentType;
  /** The role that decided the effect — recorded, not just consulted. */
  readonly authorRole: string | null;
  readonly roleEffect: string;
  /** True when this comment will reach a future context pack. */
  readonly steers: boolean;
}

export async function postComment(
  root: string,
  id: string,
  input: {
    readonly type: string;
    readonly body: string;
    readonly role?: string | undefined;
    readonly addressedTo?: string | undefined;
  },
): Promise<PostedComment> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const type = CommentTypeSchema.parse(input.type);
  const claimed = input.role === undefined ? null : AuthorRoleSchema.parse(input.role);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);

    // The role has to be **held**, not claimed. Until P3-RBAC-01 there were no
    // memberships to check against, so `--role` was taken at face value — and
    // since the effect is computed from the role, a self-asserted role is a
    // self-granted effect: anyone who could post a comment could post
    // `--role security --type blocker` and gate-block the card. The injection
    // defence is that the effect never comes from the body; it is worth nothing
    // if it comes from an adjacent free-text flag instead.
    const author = claimed === null ? null : await resolveAuthor(db, root, claimed);
    const role = author?.roleKey ?? null;

    // Read from the seeded dispatch rather than recomputed here (ADR-0012,
    // P3-RBAC-02). The table is the rule; a second evaluation in application
    // code is a second rule that agrees until it doesn't.
    const roleEffect = await dispatchedEffect(db, type, role);
    const port = await PostgresStorageAdapter.create(db);
    const data = parseFrontmatter(await fs.readFile(found.filePath, 'utf8')).data;
    await port.upsertWorkItem({
      id,
      type: typeof data['kind'] === 'string' ? data['kind'] : 'task',
      title: typeof data['title'] === 'string' ? data['title'] : id,
      status: typeof data['status'] === 'string' ? data['status'] : 'In Progress',
      lifecycleState: typeof data['lifecycle_state'] === 'string' ? data['lifecycle_state'] : '',
      filePath: path.relative(layout.root, found.filePath),
      contentHash: 'pending',
    });

    const rows = await db.query<{ id: number }>(
      `INSERT INTO comments (work_item_id, author_actor_id, author_role_id, type, body, role_effect, addressed_to)
       VALUES ($1,$2,(SELECT id FROM roles WHERE key = $3),$4,$5,$6,$7) RETURNING id;`,
      [id, author?.actorId ?? null, role, type, input.body, roleEffect, input.addressedTo ?? null],
    );

    return {
      id: rows[0]?.id ?? 0,
      workItemId: id,
      type,
      authorRole: role,
      roleEffect,
      steers: roleEffect === 'CONTEXT_INJECTION' || roleEffect === 'DECISION_TO_MEMORY',
    };
  } finally {
    await db.close();
  }
}

/** Every comment on an item, as the typed shape the dispatch consumers expect. */
export async function commentsFor(root: string, id: string): Promise<readonly Comment[]> {
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const rows = await db.query<{
      id: number;
      work_item_id: string;
      type: string;
      body: string;
      role_effect: string;
      author_role: string | null;
      addressed_to: string | null;
      created_at: Date | string;
    }>(
      `SELECT c.id, c.work_item_id, c.type, c.body, c.role_effect, c.addressed_to, c.created_at,
              r.key AS author_role
         FROM comments c LEFT JOIN roles r ON r.id = c.author_role_id
        WHERE c.work_item_id = $1 ORDER BY c.created_at, c.id;`,
      [id],
    );
    return rows.map((row) =>
      CommentSchema.parse({
        id: Number(row.id),
        workItemId: row.work_item_id,
        type: row.type,
        // The role as it was at insert, read from the row rather than from the
        // author's memberships today. A comment's meaning is fixed when it is
        // written; re-deriving it would let a role change rewrite the past.
        authorRole: row.author_role,
        body: row.body,
        // Read from the column, never recomputed. A reader that recomputes is a
        // reader that can be given different inputs.
        roleEffect: row.role_effect,
        addressedTo: row.addressed_to,
        createdAt:
          row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      }),
    );
  } finally {
    await db.close();
  }
}

/**
 * The `comment-directives` layer for the next pack this item assembles.
 *
 * This is the wiring FEAT-CMT-011 asks for, and until now `AssembleInput`
 * declared the slot with nothing on the other end of it.
 */
export async function directivesFor(
  root: string,
  id: string,
  audience: DirectiveAudience = {},
): Promise<string | undefined> {
  return renderCommentDirectives(await commentsFor(root, id), audience);
}

import {
  AuthorRoleSchema,
  CommentSchema,
  CommentTypeSchema,
  resolveWorkspaceLayout,
  roleEffectFor,
  type Comment,
  type CommentType,
} from '@sdlc-on-fire/core';
import { renderCommentDirectives, type DirectiveAudience } from '@sdlc-on-fire/context';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';

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

export interface PostedComment {
  readonly id: number;
  readonly workItemId: string;
  readonly type: CommentType;
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
  const role = input.role === undefined ? null : AuthorRoleSchema.parse(input.role);
  // Computed from the type and the role. The body is not in scope here, and
  // that is not an oversight — it is the injection defence.
  const roleEffect = roleEffectFor(type, role);

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
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
      `INSERT INTO comments (work_item_id, type, body, role_effect, addressed_to)
       VALUES ($1,$2,$3,$4,$5) RETURNING id;`,
      [id, type, input.body, roleEffect, input.addressedTo ?? null],
    );

    return {
      id: rows[0]?.id ?? 0,
      workItemId: id,
      type,
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
      addressed_to: string | null;
      created_at: Date | string;
    }>(
      `SELECT id, work_item_id, type, body, role_effect, addressed_to, created_at
         FROM comments WHERE work_item_id = $1 ORDER BY created_at, id;`,
      [id],
    );
    return rows.map((row) =>
      CommentSchema.parse({
        id: Number(row.id),
        workItemId: row.work_item_id,
        type: row.type,
        // NULL until roles land. The dispatch is total over this case, so a row
        // written today still resolves the same way when read tomorrow.
        authorRole: null,
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

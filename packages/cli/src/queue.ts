import {
  resolveWaves,
  resolveWorkspaceLayout,
  WaveCycleError,
  type WaveTask,
} from '@sdlc-on-fire/core';
import { applySchema, PostgresStorageAdapter } from '@sdlc-on-fire/db';
import { rebuildMirror } from '@sdlc-on-fire/daemon';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc queue` — what can be worked on now, and what is waiting on what
 * (P1-SCHED-02).
 *
 * `resolveWaves` shipped with the task spec, fully tested, and had no caller
 * anywhere in the product. `blocked_by` was on the cards and in the frontmatter
 * allowlist, and nothing ever read it outside that one pure function. So the
 * dependency graph existed, the scheduler existed, and no command would tell you
 * what to do next.
 *
 * Ordering inside a wave comes from `risk_level`, not a new field. An author
 * already states risk; asking them to also state a priority would mean two
 * answers to one question, and the second would be the stale one.
 *
 * A cycle is reported, not routed around. Silently dropping one edge to make the
 * graph acyclic would produce a plan that schedules work against code that does
 * not exist yet, and the plan would look fine.
 */

export interface QueueEntry {
  readonly id: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly riskLevel: string;
  readonly blockedBy: readonly string[];
  readonly claimedBy: string | null;
}

export interface QueueResult {
  readonly waves: readonly { readonly index: number; readonly items: readonly QueueEntry[] }[];
  /** Present when the dependency graph cannot be ordered at all. */
  readonly cycle?: readonly string[] | undefined;
  /** Items already finished, excluded from the plan. */
  readonly completed: readonly string[];
}

async function readCards(
  kanbanDir: string,
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const out: { id: string; data: Record<string, unknown> }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.md')) {
        const data = parseFrontmatter(await fs.readFile(full, 'utf8')).data;
        if (typeof data['id'] === 'string') out.push({ id: data['id'], data });
      }
    }
  };
  await walk(kanbanDir);
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function queueFor(root: string): Promise<QueueResult> {
  const layout = resolveWorkspaceLayout(root);
  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    const port = await PostgresStorageAdapter.create(db);
    await rebuildMirror(layout.root, port);

    const cards = await readCards(layout.kanbanDir);
    const claims = await db.query<{ id: string; claimed_by: string | null }>(
      'SELECT id, claimed_by FROM work_items;',
    );
    const claimedBy = new Map(claims.map((row) => [row.id, row.claimed_by]));

    const str = (data: Record<string, unknown>, key: string, fallback = ''): string =>
      typeof data[key] === 'string' ? data[key] : fallback;
    const list = (data: Record<string, unknown>, key: string): string[] =>
      Array.isArray(data[key])
        ? (data[key] as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];

    // Finished work is excluded rather than shown as wave 0. A plan whose first
    // wave is mostly already-done items is a plan nobody reads twice.
    const completed = cards
      .filter((card) => str(card.data, 'lifecycle_state') === 'done')
      .map((card) => card.id);
    const done = new Set(completed);
    const open = cards.filter((card) => !done.has(card.id));

    const PRIORITY: Readonly<Record<string, number>> = { high: 2, medium: 1, low: 0 };
    const tasks: WaveTask[] = open.map((card) => ({
      id: card.id,
      fileOwnership: list(card.data, 'file_ownership'),
      // Passed through whole. A dependency on finished work is already treated
      // as satisfied by `resolveWaves` — an id absent from the remaining set
      // cannot block — and filtering here as well would be a second copy of that
      // rule, free to drift from the one that actually decides.
      blockedBy: list(card.data, 'blocked_by'),
      priority: PRIORITY[str(card.data, 'risk_level', 'low')] ?? 0,
      ...(typeof card.data['wave'] === 'number' ? { wave: card.data['wave'] } : {}),
    }));

    const entry = (id: string): QueueEntry => {
      const card = open.find((candidate) => candidate.id === id);
      const data = card?.data ?? {};
      return {
        id,
        title: str(data, 'title', id),
        lifecycleState: str(data, 'lifecycle_state', '?'),
        riskLevel: str(data, 'risk_level', 'low'),
        blockedBy: list(data, 'blocked_by'),
        claimedBy: claimedBy.get(id) ?? null,
      };
    };

    try {
      const waves = resolveWaves(tasks);
      return {
        waves: waves
          .filter((wave) => wave.taskIds.length > 0)
          .map((wave) => ({ index: wave.index, items: wave.taskIds.map(entry) })),
        completed,
      };
    } catch (error) {
      if (error instanceof WaveCycleError) {
        return { waves: [], cycle: error.remaining, completed };
      }
      throw error;
    }
  } finally {
    await db.close();
  }
}

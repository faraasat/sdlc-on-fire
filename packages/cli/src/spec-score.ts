import fs from 'node:fs/promises';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { applySchema } from '@sdlc-on-fire/db';
import { coverageFor, scoreSpecQuality, type SpecQualityScore } from '@sdlc-on-fire/evidence';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { findWorkItem, openWorkspaceDatabase } from './commands.js';

/**
 * `sdlc score` — the observed spec-quality number (P1-OBJ-07).
 *
 * Reachable, because a metric nobody can look at is a metric nobody watches —
 * and this build has found nine capabilities that existed and had no caller.
 * It exits 0 whatever the number says: the score is a trend line, not a gate,
 * and an exit code is how a number becomes one by accident in someone's CI.
 */
export async function scoreWorkItem(root: string, id: string): Promise<SpecQualityScore> {
  const layout = resolveWorkspaceLayout(root);
  const found = await findWorkItem(layout.kanbanDir, id);
  if (found === null) throw new Error(`no work item with id "${id}" under ${layout.kanbanDir}`);

  const data = parseFrontmatter(await fs.readFile(found.filePath, 'utf8')).data;
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

  const { db } = await openWorkspaceDatabase(root);
  try {
    await applySchema(db);
    return scoreSpecQuality({
      workItemId: id,
      acceptanceCriteria: list(data['done']),
      nonGoals: list(data['non_goals']),
      coverage: await coverageFor(db, id),
    });
  } finally {
    await db.close();
  }
}

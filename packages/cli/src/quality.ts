import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { analyseFile, summariseQuality, type QualitySummary } from '@sdlc-on-fire/evidence';

/**
 * `sdlc quality` — doc-comment presence and comment-bloat candidates
 * (P1-GATE-11, ADR-0055/0056).
 *
 * Reports the two halves separately because they have different standing:
 * missing doc-comments on exported API is a deterministic failure, and
 * "this comment is bloated" is a nudge for a human. Printing them in one list
 * would give the heuristic authority it has not earned.
 */

export interface QualityResult extends QualitySummary {
  readonly scanned: string;
}

/** Walks a directory for TypeScript sources, skipping build output and tests. */
async function sources(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.sdlcof'].includes(entry.name)) continue;
      await sources(full, acc);
    } else if (
      /\.(ts|tsx|js|mjs)$/.test(entry.name) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

export async function scanQuality(root: string, subpath?: string): Promise<QualityResult> {
  const layout = resolveWorkspaceLayout(root);
  const target = subpath === undefined ? layout.root : path.resolve(layout.root, subpath);
  const files = await sources(target);
  const reports = await Promise.all(
    files.map(async (file) =>
      analyseFile(path.relative(layout.root, file), await fs.readFile(file, 'utf8')),
    ),
  );
  return { scanned: path.relative(layout.root, target) || '.', ...summariseQuality(reports) };
}

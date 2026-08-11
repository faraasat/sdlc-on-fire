import fs from 'node:fs/promises';
import path from 'node:path';
import {
  evaluateThreatModel,
  formatThreatModel,
  MAESTRO_LAYERS,
  STRIDE_CATEGORIES,
  type ThreatEntry,
  type ThreatModelResult,
  type ToolSurface,
} from '@sdlc-on-fire/core';

/**
 * `sdlc threat-model` (P2-SEC-06).
 *
 * The grid lives in the workspace as a file, in git, like everything else that
 * is content rather than state. That is what makes it reviewable in a PR, and
 * what makes an accepted risk something a person can find later by reading a
 * diff instead of by remembering a conversation.
 */

export const THREAT_MODEL_DIR = path.join('.sdlcof', 'threat-models');

interface ThreatModelFile {
  name?: string;
  layers?: string[];
  components?: string[];
  entries?: ThreatEntry[];
}

export interface ThreatCheckResult {
  readonly surfaces: readonly ThreatModelResult[];
  readonly complete: boolean;
  /** Surfaces found on disk that could not be read. */
  readonly unreadable: readonly string[];
}

/**
 * A scaffold with every cell present and none of them answered.
 *
 * Generated blank on purpose. Pre-filling dispositions would put an answer
 * nobody reached in a file that will be skimmed, and a grid that arrives
 * looking finished is a grid nobody finishes.
 */
export function scaffoldThreatModel(name: string, components: readonly string[]): string {
  const entries = components.flatMap((component) =>
    STRIDE_CATEGORIES.map((category) => ({
      component,
      category,
      disposition: 'mitigated',
      rationale: '',
    })),
  );

  return `${JSON.stringify(
    {
      name,
      layers: [...MAESTRO_LAYERS],
      components: [...components],
      entries,
    },
    null,
    2,
  )}\n`;
}

function toSurface(file: ThreatModelFile, fallbackName: string): ToolSurface {
  return {
    name: file.name ?? fallbackName,
    layers: (file.layers ?? []).filter((layer): layer is ToolSurface['layers'][number] =>
      (MAESTRO_LAYERS as readonly string[]).includes(layer),
    ),
    components: file.components ?? [],
  };
}

export async function checkThreatModels(root: string): Promise<ThreatCheckResult> {
  const dir = path.join(root, THREAT_MODEL_DIR);
  const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();

  const surfaces: ThreatModelResult[] = [];
  const unreadable: string[] = [];

  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
    if (raw === null) {
      unreadable.push(file);
      continue;
    }
    let parsed: ThreatModelFile;
    try {
      parsed = JSON.parse(raw) as ThreatModelFile;
    } catch {
      // A model nobody can parse is a model nobody reviewed. Counting it as
      // absent rather than as passing.
      unreadable.push(file);
      continue;
    }
    surfaces.push(
      evaluateThreatModel(toSurface(parsed, path.basename(file, '.json')), parsed.entries ?? []),
    );
  }

  return {
    surfaces,
    unreadable,
    complete: unreadable.length === 0 && surfaces.length > 0 && surfaces.every((s) => s.complete),
  };
}

export function formatThreatCheck(result: ThreatCheckResult): string {
  if (result.surfaces.length === 0 && result.unreadable.length === 0) {
    return [
      'No threat models found.',
      '',
      `Nothing was checked — not that nothing needs checking. Scaffold one under`,
      `${THREAT_MODEL_DIR}/ before a new tool surface ships.`,
    ].join('\n');
  }

  const lines = result.surfaces.map((surface) => formatThreatModel(surface));
  for (const file of result.unreadable) {
    lines.push(`✗ ${file} could not be read — a model nobody can parse is a model nobody reviewed`);
  }
  return lines.join('\n\n');
}

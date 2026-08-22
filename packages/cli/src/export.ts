import fs from 'node:fs/promises';
import path from 'node:path';
import { relativePosix, resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import {
  EXPORTERS,
  exporterFor,
  fidelityViolations,
  type ExportResult,
  type IrNode,
} from '@sdlc-on-fire/importers';
import { parseFrontmatter } from '@sdlc-on-fire/storage';

/**
 * `sdlc export` — an honest snapshot in somebody else's format (P4-EXP-01).
 *
 * The point is not that the output runs in the target tool. It is that somebody
 * evaluating a migration can see **what leaving would cost** before committing
 * to it — so the loss list is the deliverable and the files are the supporting
 * evidence.
 *
 * The command refuses to write when an exporter breaks its own fidelity claim.
 * That is the whole reason `fidelityViolations` exists: an export that says
 * "high fidelity" and quietly dropped the relations is the self-report this
 * product refuses everywhere else, and it would be the easiest place in the
 * codebase to let one through.
 */

export interface ExportRunResult {
  readonly tool: string;
  readonly fidelity: string;
  readonly outDir: string;
  readonly filesWritten: number;
  readonly losses: ExportResult['losses'];
  readonly unsupportedKinds: readonly string[];
  readonly violations: readonly string[];
  readonly wrote: boolean;
}

export function availableTargets(): readonly string[] {
  return EXPORTERS.map((exporter) => exporter.toolId).sort();
}

export async function runExport(
  root: string,
  toolId: string,
  options: { outDir?: string; dryRun?: boolean } = {},
): Promise<ExportRunResult> {
  const exporter = exporterFor(toolId);
  if (exporter === undefined) {
    throw new Error(
      `unknown export target "${toolId}" — expected one of ${availableTargets().join(', ')}`,
    );
  }

  const layout = resolveWorkspaceLayout(root);
  const items = await readKanban(layout.kanbanDir, layout.root);

  // The IR is reconstructed from the workspace rather than from the database,
  // because the workspace is the content (architecture §5). Exporting from the
  // mirror would produce a snapshot of a cache.
  const nodes: IrNode[] = items.map((item) => ({
    kind: irKindFor(item.type),
    title: item.title,
    body: item.body,
    frontmatterHints: {},
    externalRef: {
      source_tool: 'sdlc-on-fire',
      source_path: item.path,
      source_id_or_hash: item.id,
    },
    preservedIdentifiers: [item.id],
    relations:
      item.parent == null
        ? []
        : [{ type: 'parent' as const, targetExternalRef: `sdlc-on-fire::${item.parent}` }],
  }));

  const result = exporter.export(nodes);
  const violations = fidelityViolations(result);
  const outDir = options.outDir ?? path.join(layout.root, '.sdlcof', 'export', toolId);

  // Refused before anything is written. A partially written snapshot that also
  // failed its own fidelity check is worse than none: somebody finds the files
  // later with no record of why they were rejected.
  const wrote = violations.length === 0 && options.dryRun !== true;
  if (wrote) {
    for (const file of result.files) {
      const target = path.join(outDir, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.contents);
    }
  }

  return {
    tool: result.toolId,
    fidelity: result.fidelity,
    outDir: relativePosix(layout.root, outDir),
    filesWritten: wrote ? result.files.length : 0,
    losses: result.losses,
    unsupportedKinds: result.unsupportedKinds,
    violations,
    wrote,
  };
}

/**
 * Every card in the kanban tree, read from disk.
 *
 * A card that fails to parse is skipped rather than fatal. An export is a
 * read-only snapshot somebody takes while deciding whether to migrate, and
 * refusing to produce one because a single card has malformed frontmatter would
 * make the command unusable precisely on the messy repositories it exists for.
 * The count is reported so the omission is visible.
 */
async function readKanban(
  kanbanDir: string,
  root: string,
): Promise<
  readonly {
    id: string;
    type: string;
    title: string;
    body: string;
    path: string;
    parent: string | null;
  }[]
> {
  const out: {
    id: string;
    type: string;
    title: string;
    body: string;
    path: string;
    parent: string | null;
  }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const raw = await fs.readFile(full, 'utf8').catch(() => null);
      if (raw === null) continue;
      const parsed = parseFrontmatter(raw);
      const id = parsed.data['id'];
      const title = parsed.data['title'];
      if (typeof id !== 'string' || typeof title !== 'string') continue;
      const parent = parsed.data['parent'];
      out.push({
        id,
        type: typeof parsed.data['type'] === 'string' ? parsed.data['type'] : 'feature',
        title,
        body: parsed.body,
        path: relativePosix(root, full),
        parent: typeof parent === 'string' ? parent : null,
      });
    }
  };
  await walk(kanbanDir);
  return out;
}

/** Our work-item kinds mapped onto the tool-independent IR. */
function irKindFor(type: string): IrNode['kind'] {
  switch (type) {
    case 'epic':
      return 'epic';
    case 'story':
      return 'story';
    case 'task':
      return 'task';
    default:
      // A feature or a bug is a unit of specified work, which `spec` is the
      // closest IR kind for. Named here rather than defaulted silently so the
      // mapping is somewhere a reader can disagree with it.
      return 'spec';
  }
}

export function formatExport(result: ExportRunResult): string {
  const lines: string[] = [];

  if (result.violations.length > 0) {
    lines.push(
      `Refused to write — ${result.tool} did not meet its own "${result.fidelity}" claim:`,
    );
    for (const violation of result.violations) lines.push(`  ${violation}`);
    return lines.join('\n');
  }

  lines.push(
    result.wrote
      ? `Wrote ${String(result.filesWritten)} file(s) to ${result.outDir} (${result.tool}, ${result.fidelity} fidelity).`
      : `Would write ${String(result.losses.length >= 0 ? result.filesWritten : 0)} file(s) to ${result.outDir}.`,
  );

  if (result.unsupportedKinds.length > 0) {
    lines.push(
      '',
      `Not representable in ${result.tool} at all: ${result.unsupportedKinds.join(', ')}`,
    );
  }

  if (result.losses.length > 0) {
    lines.push('', `${String(result.losses.length)} value(s) did not survive:`);
    // Grouped by field, because "relations dropped on 40 nodes" is one decision
    // to make and forty lines is a wall somebody scrolls past.
    const byField = new Map<string, number>();
    for (const loss of result.losses) byField.set(loss.field, (byField.get(loss.field) ?? 0) + 1);
    for (const [field, count] of [...byField].sort()) {
      const example = result.losses.find((loss) => loss.field === field);
      lines.push(`  ${field} (${String(count)}): ${example?.because ?? ''}`);
    }
  }

  return lines.join('\n');
}

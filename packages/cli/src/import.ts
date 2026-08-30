import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyImport,
  externalRefKey,
  planImport,
  type ExistingItem,
  type ImportPlan,
  type IrNode,
  type ParseWarning,
  type PlannedNode,
  type ToolParser,
} from '@sdlc-on-fire/importers';
import { resolveWorkspaceLayout } from '@sdlc-on-fire/core';
import { parseFrontmatter } from '@sdlc-on-fire/storage';
import { ALL_PARSERS, detectTools } from './detect.js';

/**
 * `sdlc import` (P2-IMP-07, `.research/10 §3`).
 *
 * **Dry-run is the same computation as the real run.** It reports the plan the
 * import would apply, not a prediction of it — two implementations of "what
 * would this do" is exactly how a preview comes to disagree with the thing it
 * previews, and the disagreement surfaces only after the write.
 *
 * **Originals are copied, never moved and never mutated.** A migration that
 * consumes its own source leaves the user with no way back and no way to
 * compare. `--preserve-originals` (the default) copies the whole source tree
 * under `.sdlcof/imported/<tool>/<run>/` before anything is written.
 *
 * **Idempotency is the feature, not an optimisation.** A real migration is:
 * import, notice one source file was wrong, fix it, import again. Because the
 * plan is keyed on `external_ref` — which lives in each card's frontmatter and
 * therefore survives `db:rebuild` — the second run touches the file that
 * changed and leaves the other four hundred alone.
 */

const sha = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

export interface ImportOptions {
  readonly from?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly into?: string | undefined;
  readonly preserveOriginals?: boolean | undefined;
  readonly onConflict?: ConflictPolicy | undefined;
  readonly parsers?: readonly ToolParser[] | undefined;
}

export interface ImportReport {
  readonly tool: string;
  readonly dialect: string;
  readonly confidence: string;
  readonly dryRun: boolean;
  readonly plan: ImportPlan;
  readonly warnings: readonly ParseWarning[];
  readonly skippedFiles: readonly string[];
  /** The subfolder imports land in, under both the kanban and docs trees. */
  readonly writtenTo: string;
  readonly originalsCopiedTo?: string | undefined;
  readonly committed: boolean;
  /** Conflicts with items that already exist and did NOT come from this import. */
  readonly conflicts: readonly string[];
}

/** Every `external_ref` already recorded in the workspace, read from the files. */
export async function existingImports(root: string): Promise<readonly ExistingItem[]> {
  const layout = resolveWorkspaceLayout(root);
  const out: ExistingItem[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const raw = await fs.readFile(full, 'utf8').catch(() => null);
      if (raw === null) continue;

      const ref = parseFrontmatter(raw).data['external_ref'];
      if (ref === null || typeof ref !== 'object') continue;
      const { source_tool, source_path, source_id_or_hash } = ref as Record<string, unknown>;
      if (
        typeof source_tool !== 'string' ||
        typeof source_path !== 'string' ||
        typeof source_id_or_hash !== 'string'
      ) {
        continue;
      }
      // Hashed on what a re-import would produce, so "unchanged" means the
      // source still says the same thing — not merely that a file exists.
      const parsed = parseFrontmatter(raw);
      const title = typeof parsed.data['title'] === 'string' ? parsed.data['title'] : '';
      out.push({
        key: externalRefKey({ source_tool, source_path, source_id_or_hash }),
        contentHash: sha(`${title}\n\n${parsed.body.trim()}`),
      });
    }
  };

  await walk(layout.kanbanDir);
  await walk(layout.docsDir);
  return out;
}

/**
 * Where a node lands. Kind decides the tree; nothing is written outside it.
 *
 * **The filename carries a digest of the full identity, not just the readable
 * part** (P8-MIGRATE-01). A node's identity is the triple
 * `(source_tool, source_path, source_id_or_hash)`; the name used to be built
 * from the last third alone, so two nodes with the same identifier set from
 * *different* source files produced the same path and the second silently
 * overwrote the first.
 *
 * That is not hypothetical and it is not rare. Spec Kit numbers `FR-001`
 * independently **per feature directory**, so any repository with more than one
 * feature is a collision waiting to happen. Importing
 * `radius-project/radius` — a real project from the wild, 3,834 files —
 * produced **51 spec nodes and 48 files**: three specs lost, no warning, and a
 * re-run that reported three conflicts on paths the first run had written
 * itself. The round-trip gate could not see it because our own fixtures were
 * written with unique identifiers.
 *
 * The 48-character truncation compounded it: two long identifier lists sharing
 * a prefix collided even when the sets differed.
 *
 * The readable prefix is kept — `FR-001-FR-002-a1b2c3d4.md` is far better to
 * scan than a bare hash — but the digest is what makes the name a function of
 * the whole identity, so two files collide only when they are the same node.
 */
export function targetPathFor(root: string, node: IrNode, into?: string): string {
  const layout = resolveWorkspaceLayout(root);
  const readable = node.externalRef.source_id_or_hash.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
  // Over the whole ref, not just `source_path`: two nodes could share a source
  // file and differ only by identifier set, which is the ordinary case for a
  // spec split into sections.
  const digest = sha(externalRefKey(node.externalRef)).slice(0, 8);
  const slug = readable === '' ? digest : `${readable}-${digest}`;
  const base =
    node.kind === 'spec' || node.kind === 'constitution' ? layout.docsDir : layout.kanbanDir;
  const folder = into === undefined ? '_imported' : into;
  return path.join(base, folder, node.kind, `${slug}.md`);
}

function renderNode(node: IrNode): string {
  const frontmatter = {
    external_ref: node.externalRef,
    title: node.title,
    imported_kind: node.kind,
    ...(node.preservedIdentifiers.length === 0
      ? {}
      : { preserved_identifiers: node.preservedIdentifiers }),
    ...node.frontmatterHints,
  };
  // Written as an imported artefact, not as a work item: an import must not
  // fabricate a lifecycle_state, and contracts/02 requires a real one. Promotion
  // to a work item is a separate, human-visible step.
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `---\n${yaml}\n---\n\n${node.body.trim()}\n`;
}

export async function runImport(root: string, options: ImportOptions = {}): Promise<ImportReport> {
  const parsers = options.parsers ?? ALL_PARSERS;
  const detected = await detectTools(root, parsers);

  const chosen =
    options.from === undefined
      ? [...detected.matches].sort((a, b) =>
          a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1,
        )[0]
      : detected.matches.find((match) => match.toolId === options.from);

  if (chosen === undefined) {
    throw new Error(
      options.from === undefined
        ? 'nothing to import — no supported source format was detected here. Run `sdlc detect` to see what was looked for.'
        : `no ${options.from} source was detected here. Run \`sdlc detect\` to see what is actually present.`,
    );
  }

  const parser = parsers.find(
    (candidate) => candidate.toolId === chosen.toolId && candidate.dialect === chosen.dialect,
  );
  if (parser === undefined) throw new Error(`no parser for ${chosen.toolId}/${chosen.dialect}`);

  const parsed = await parser.parse(root);
  const existing = await existingImports(root);
  const plan = planImport(parsed.items, existing, sha);

  // A conflict is a target file that exists but carries no matching
  // `external_ref` — something a human wrote, standing where an import wants to
  // land. Silently overwriting it is the worst possible default.
  const conflicts: string[] = [];
  for (const planned of plan.order) {
    if (planned.action !== 'create') continue;
    const target = targetPathFor(root, planned.node, options.into);
    if (
      await fs
        .stat(target)
        .then(() => true)
        .catch(() => false)
    )
      conflicts.push(target);
  }
  const policy = options.onConflict ?? 'fail';
  if (conflicts.length > 0 && policy === 'fail' && options.dryRun !== true) {
    throw new Error(
      `import refused: ${String(conflicts.length)} target file(s) already exist and were not written by an import — ` +
        `${conflicts.slice(0, 3).join(', ')}. Re-run with --on-conflict skip or --on-conflict overwrite once you have looked.`,
    );
  }

  const layout = resolveWorkspaceLayout(root);
  let originalsCopiedTo: string | undefined;

  if (options.dryRun === true) {
    return {
      tool: chosen.toolId,
      dialect: chosen.dialect,
      confidence: chosen.confidence,
      dryRun: true,
      plan,
      warnings: parsed.warnings,
      skippedFiles: parsed.skippedFiles,
      writtenTo: options.into ?? '_imported',
      committed: false,
      conflicts,
    };
  }

  if (options.preserveOriginals !== false) {
    // Copied before a single write. A migration that consumes its source leaves
    // the user no way back and nothing to compare against.
    //
    // Only the directories the parser actually read, derived from the nodes'
    // own `source_path`s. Copying the whole workspace would drag in
    // `node_modules` and — because the destination lives under `.sdlcof/` —
    // Node refuses outright: `cp` will not copy a directory into itself.
    const sourceRoots = new Set(
      parsed.items
        .map((node) => node.externalRef.source_path.split('/')[0])
        .filter((segment): segment is string => segment !== undefined && segment !== ''),
    );
    const stamp = sha(`${chosen.toolId}:${String(plan.order.length)}`).slice(0, 8);
    originalsCopiedTo = path.join(layout.stateDir, 'imported', chosen.toolId, stamp);
    await fs.mkdir(originalsCopiedTo, { recursive: true });
    for (const source of sourceRoots) {
      await fs
        .cp(path.join(root, source), path.join(originalsCopiedTo, source), { recursive: true })
        .catch(() => undefined);
    }
  }

  const written: string[] = [];
  const result = await applyImport(
    plan,
    async (planned: PlannedNode) => {
      const target = targetPathFor(root, planned.node, options.into);
      if (policy === 'skip' && conflicts.includes(target)) return;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, renderNode(planned.node), 'utf8');
      written.push(target);
    },
    async (applied) => {
      // All of it or none of it. A half-applied import leaves a workspace in a
      // state neither the source nor the target describes.
      void applied;
      await Promise.all(written.map((file) => fs.rm(file, { force: true })));
    },
  );

  return {
    tool: chosen.toolId,
    dialect: chosen.dialect,
    confidence: chosen.confidence,
    dryRun: false,
    plan,
    warnings: parsed.warnings,
    skippedFiles: parsed.skippedFiles,
    writtenTo: options.into ?? '_imported',
    ...(originalsCopiedTo === undefined ? {} : { originalsCopiedTo }),
    committed: result.committed,
    conflicts,
  };
}

export function formatImport(report: ImportReport): string {
  const lines = [
    `${report.dryRun ? 'would import' : 'imported'} from ${report.tool}/${report.dialect} (confidence: ${report.confidence})`,
    `  create ${String(report.plan.created)}   update ${String(report.plan.updated)}   unchanged ${String(report.plan.unchanged)}`,
  ];
  if (!report.dryRun) {
    // Both trees, because specs and constitutions land under `docs/` while work
    // items land under `kanban/`. Naming only one was a report that did not
    // describe where half the files went.
    lines.push(`  into    kanban/${report.writtenTo}/ and docs/${report.writtenTo}/`);
  }
  if (report.originalsCopiedTo !== undefined) {
    lines.push(`  originals copied to ${report.originalsCopiedTo} (never moved, never modified)`);
  }
  for (const warning of report.warnings) lines.push(`  ⚠ ${warning.file}: ${warning.message}`);
  if (report.plan.danglingRelations.length > 0) {
    lines.push(
      `  ⚠ ${String(report.plan.danglingRelations.length)} relation(s) point at something not in this import —`,
      '    the source tree was incomplete, and the links are recorded rather than dropped',
    );
  }
  if (report.conflicts.length > 0) {
    lines.push(`  ⚠ ${String(report.conflicts.length)} target file(s) already existed`);
  }
  if (report.confidence !== 'high') {
    lines.push('  ⚠ this was not a high-confidence match — read the plan before trusting it');
  }
  if (!report.dryRun && !report.committed) {
    lines.push('  ✗ a write failed; everything already written was rolled back');
  }
  return lines.join('\n');
}

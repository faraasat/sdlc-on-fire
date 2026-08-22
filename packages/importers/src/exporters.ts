/**
 * The four exporters (P4-EXP-01).
 *
 * Each is small on purpose. The value here is not format emulation — nobody
 * should import our output back into BMAD and expect it to run — it is an
 * **honest snapshot with a declared loss list**, so somebody evaluating a
 * migration can see what leaving would cost before they commit to it.
 *
 * Every exporter shares one rule: a value that cannot be represented is
 * *recorded*, never dropped. The failure mode this prevents is the one that
 * makes round-trip claims worthless — an export that looks complete, imports
 * cleanly, and is quietly missing the relations.
 */

import type { IrKind, IrNode } from './ir.js';
import {
  slugify,
  unsupported,
  type ExportLoss,
  type ExportResult,
  type ExportedFile,
  type ToolExporter,
} from './export-port.js';

/** Frontmatter rendering shared by every exporter that has frontmatter at all. */
function frontmatter(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  const lines = entries.map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.map(String).join(', ')}]` : `${key}: ${String(value)}`,
  );
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * Losses common to every target: nothing outside our own workspace layout
 * carries an external ref or our relation vocabulary verbatim.
 */
function commonLosses(
  node: IrNode,
  keeps: { relations: boolean; externalRef: boolean },
): ExportLoss[] {
  const losses: ExportLoss[] = [];
  if (!keeps.relations && node.relations.length > 0) {
    losses.push({
      nodeTitle: node.title,
      kind: node.kind,
      field: 'relations',
      because: 'the target format has no cross-document relation vocabulary',
    });
  }
  if (!keeps.externalRef) {
    losses.push({
      nodeTitle: node.title,
      kind: node.kind,
      field: 'externalRef',
      because: 'provenance of the original import is not representable in the target',
    });
  }
  return losses;
}

function build(
  toolId: string,
  dialect: string,
  fidelity: ExportResult['fidelity'],
  supports: readonly IrKind[],
  nodes: readonly IrNode[],
  emit: (node: IrNode) => { file: ExportedFile; losses: ExportLoss[] },
): ExportResult {
  const files: ExportedFile[] = [];
  const losses: ExportLoss[] = [];
  for (const node of nodes) {
    if (!supports.includes(node.kind)) continue;
    const { file, losses: nodeLosses } = emit(node);
    files.push(file);
    losses.push(...nodeLosses);
  }
  return {
    toolId,
    dialect,
    fidelity,
    // Sorted so an export is byte-stable: this output gets diffed against a
    // previous snapshot, and ordering that followed input order would produce a
    // diff whenever the database returned rows differently.
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    losses,
    unsupportedKinds: unsupported(nodes, supports),
  };
}

/**
 * OpenSpec — **high**.
 *
 * The only target that earns the tier, and it earns it because its model is the
 * closest to ours: spec documents under `specs/<domain>/spec.md`, deltas under
 * `changes/`, and an archive. Relations survive as `delta-of` links written into
 * the change's own frontmatter, which is where OpenSpec already looks.
 */
export const openSpecExporter: ToolExporter = {
  toolId: 'openspec',
  dialect: 'openspec/0.x',
  fidelity: 'high',
  supports: ['spec', 'change', 'constitution'],
  export(nodes) {
    return build('openspec', 'openspec/0.x', 'high', this.supports, nodes, (node) => {
      const slug = slugify(node.title);
      const path =
        node.kind === 'constitution'
          ? 'openspec/project.md'
          : node.kind === 'change'
            ? `openspec/changes/${slug}/proposal.md`
            : `openspec/specs/${slug}/spec.md`;

      // `delta-of` is OpenSpec's own idea, so it survives; the identifiers are
      // written verbatim because renumbering them silently breaks every commit
      // and PR that referenced them.
      const deltas = node.relations.filter((relation) => relation.type === 'delta-of');
      const other = node.relations.filter((relation) => relation.type !== 'delta-of');

      const losses: ExportLoss[] = [];
      if (other.length > 0) {
        losses.push({
          nodeTitle: node.title,
          kind: node.kind,
          field: 'relations',
          because: `OpenSpec represents delta-of only; dropped: ${other.map((r) => r.type).join(', ')}`,
        });
      }

      return {
        file: {
          path,
          contents:
            frontmatter({
              ...node.frontmatterHints,
              ...(node.preservedIdentifiers.length > 0
                ? { identifiers: node.preservedIdentifiers }
                : {}),
              ...(deltas.length > 0 ? { 'delta-of': deltas.map((r) => r.targetExternalRef) } : {}),
              'external-ref': `${node.externalRef.source_tool}:${node.externalRef.source_path}`,
            }) + `# ${node.title}\n\n${node.body}\n`,
        },
        losses,
      };
    });
  },
};

/**
 * Spec Kit — **moderate**.
 *
 * Flat numbered spec files. Fields survive; the graph does not, because Spec
 * Kit has no way to say one document is about another.
 */
export const specKitExporter: ToolExporter = {
  toolId: 'speckit',
  dialect: 'speckit/1.x',
  fidelity: 'moderate',
  supports: ['spec', 'constitution', 'verification'],
  export(nodes) {
    return build('speckit', 'speckit/1.x', 'moderate', this.supports, nodes, (node) => ({
      file: {
        path:
          node.kind === 'constitution'
            ? 'memory/constitution.md'
            : `specs/${slugify(node.title)}.md`,
        contents:
          frontmatter({
            ...(node.preservedIdentifiers.length > 0
              ? { requirements: node.preservedIdentifiers }
              : {}),
          }) + `# ${node.title}\n\n${node.body}\n`,
      },
      losses: commonLosses(node, { relations: false, externalRef: false }),
    }));
  },
};

/**
 * GSD — **moderate**.
 *
 * Epics and tasks, which our IR has directly. Specs have no home, so they are
 * reported as unsupported rather than flattened into task descriptions where a
 * reader would mistake a requirement for a work item.
 */
export const gsdExporter: ToolExporter = {
  toolId: 'gsd',
  dialect: 'gsd/1.x',
  fidelity: 'moderate',
  supports: ['epic', 'story', 'task'],
  export(nodes) {
    return build('gsd', 'gsd/1.x', 'moderate', this.supports, nodes, (node) => ({
      file: {
        path: `.gsd/${node.kind}s/${slugify(node.title)}.md`,
        contents: `# ${node.title}\n\n${node.body}\n`,
      },
      losses: commonLosses(node, { relations: false, externalRef: false })
        .concat(
          Object.keys(node.frontmatterHints).length > 0
            ? [
                {
                  nodeTitle: node.title,
                  kind: node.kind,
                  field: 'frontmatterHints',
                  because: 'GSD task files carry no frontmatter',
                },
              ]
            : [],
        )
        .concat(
          // Found by the P2-IMP-08 round-trip gate, not by reading this code.
          // GSD files carry no frontmatter at all, so the identifiers had
          // nowhere to go — and this exporter claimed `moderate` fidelity while
          // silently dropping the strings teams reference in commits and PRs.
          node.preservedIdentifiers.length > 0
            ? [
                {
                  nodeTitle: node.title,
                  kind: node.kind,
                  field: 'preservedIdentifiers',
                  because: 'GSD files carry no frontmatter, so the ids survive only in prose',
                },
              ]
            : [],
        ),
    }));
  },
};

/**
 * BMAD — **best-effort**.
 *
 * One flat document per node with no structure claimed. The tier is the honest
 * one: we could read BMAD only partially, so writing it back is a snapshot of
 * content rather than a working project, and saying otherwise would claim to
 * know something the import direction taught us we do not.
 */
export const bmadExporter: ToolExporter = {
  toolId: 'bmad',
  dialect: 'bmad/4.x',
  fidelity: 'best-effort',
  supports: ['epic', 'story', 'spec', 'constitution'],
  export(nodes) {
    return build('bmad', 'bmad/4.x', 'best-effort', this.supports, nodes, (node) => ({
      file: {
        path: `docs/${node.kind}-${slugify(node.title)}.md`,
        contents: `# ${node.title}\n\n${node.body}\n`,
      },
      losses: commonLosses(node, { relations: false, externalRef: false }).concat(
        node.preservedIdentifiers.length > 0
          ? [
              {
                nodeTitle: node.title,
                kind: node.kind,
                field: 'preservedIdentifiers',
                because: 'no identifier field survives; the ids remain only in prose',
              },
            ]
          : [],
      ),
    }));
  },
};

export const EXPORTERS: readonly ToolExporter[] = [
  openSpecExporter,
  specKitExporter,
  gsdExporter,
  bmadExporter,
];

export function exporterFor(toolId: string): ToolExporter | undefined {
  return EXPORTERS.find((exporter) => exporter.toolId === toolId);
}

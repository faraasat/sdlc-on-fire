/**
 * Exporting the IR back out to a competitor format (P4-EXP-01).
 *
 * The mirror of `port.ts`, and deliberately not its symmetric twin. Import
 * reads someone else's format and loses whatever our IR cannot hold; export
 * writes someone else's format and loses whatever *their* format cannot hold.
 * The two losses are different, and a round trip suffers both.
 *
 * **Fidelity is a claim, so it has to carry its evidence.** Declaring a target
 * "high fidelity" and emitting files is exactly the self-report this product
 * exists to refuse. So an export returns what it *dropped*, per node and per
 * field, and the fidelity tier is checked against that record rather than
 * asserted beside it: a `high` exporter that drops a relation is a bug the
 * exporter reports about itself.
 *
 * The tiers come from the import direction's measured findings — OpenSpec high,
 * Spec Kit and GSD moderate, BMAD best-effort — because a format we could only
 * partially read is a format we can only partially write, and claiming
 * otherwise in this direction would be claiming to know something we learned we
 * did not.
 */

import type { IrKind, IrNode } from './ir.js';

/** What a target format can hold, measured rather than hoped. */
export const FIDELITY_TIERS = ['high', 'moderate', 'best-effort'] as const;
export type FidelityTier = (typeof FIDELITY_TIERS)[number];

/**
 * One thing that did not survive the export.
 *
 * `field` is the IR field, not the target's. The reader is somebody who knows
 * our model and wants to know what the other format cannot hold — telling them
 * a name from a schema they have never seen answers a different question.
 */
export interface ExportLoss {
  readonly nodeTitle: string;
  readonly kind: IrKind;
  readonly field: string;
  readonly because: string;
}

export interface ExportedFile {
  /** Target-relative posix path. */
  readonly path: string;
  readonly contents: string;
}

export interface ExportResult {
  readonly toolId: string;
  readonly dialect: string;
  readonly fidelity: FidelityTier;
  readonly files: readonly ExportedFile[];
  readonly losses: readonly ExportLoss[];
  /** Kinds this exporter has no representation for at all. */
  readonly unsupportedKinds: readonly IrKind[];
}

export interface ToolExporter {
  readonly toolId: string;
  readonly dialect: string;
  readonly fidelity: FidelityTier;
  /** Kinds this format can represent. Everything else is reported, never dropped quietly. */
  readonly supports: readonly IrKind[];
  export(nodes: readonly IrNode[]): ExportResult;
}

/**
 * Whether an exporter's output matches the fidelity it claims.
 *
 * The deterministic disposer for the one thing an exporter could lie about
 * (ADR-0040). The tier is a claim about the nodes the format *can* hold:
 * `high` means those lost nothing, `moderate` allows dropping fields on them,
 * `best-effort` promises only that what is emitted is accurate and that
 * everything omitted is listed. Kinds the format cannot represent at all are
 * reported separately and never count against the tier — see below.
 *
 * Returns the reasons rather than a boolean, because "this export did not meet
 * its tier" is not actionable and "it dropped `relations` on three nodes" is.
 */
export function fidelityViolations(result: ExportResult): readonly string[] {
  const problems: string[] = [];

  if (result.fidelity === 'high' && result.losses.length > 0) {
    const fields = [...new Set(result.losses.map((loss) => loss.field))].sort();
    problems.push(
      `claims high fidelity but dropped ${String(result.losses.length)} value(s): ${fields.join(', ')}`,
    );
  }

  // `unsupportedKinds` is deliberately NOT a violation at any tier.
  //
  // The first version of this treated it as one, and running the exporter over
  // a realistic workspace showed why that is wrong: OpenSpec has no concept of
  // an epic, so a single epic on the board made a `high` exporter refuse to
  // write anything at all — for a reason that is a property of the target
  // format rather than an infidelity in what was written.
  //
  // The tier describes **how faithfully the nodes it can represent are
  // represented**. What the target cannot hold at all is a separate fact, and
  // it is always reported, on every result, at every tier. Conflating the two
  // makes the honest exporters unusable and tells the user nothing extra.

  // True at every tier. An exporter that emits nothing and reports nothing has
  // not exported an empty project — it has failed silently, and the two look
  // identical from the outside.
  if (
    result.files.length === 0 &&
    result.losses.length === 0 &&
    result.unsupportedKinds.length === 0
  ) {
    problems.push(
      'produced no files and reported no losses — nothing to distinguish this from a failure',
    );
  }

  return problems;
}

/** Nodes an exporter cannot represent, in a stable order. */
export function unsupported(
  nodes: readonly IrNode[],
  supports: readonly IrKind[],
): readonly IrKind[] {
  const missing = new Set<IrKind>();
  for (const node of nodes) if (!supports.includes(node.kind)) missing.add(node.kind);
  return [...missing].sort();
}

/**
 * A filename-safe slug from a title.
 *
 * Collisions are the caller's problem to notice, not this function's to hide:
 * two nodes titled "Overview" produce one slug, and an exporter that silently
 * overwrote the first would lose a document without reporting a loss — the one
 * failure this whole module is arranged to prevent.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

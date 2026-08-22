/**
 * Round-trip fidelity (P2-IMP-08).
 *
 * import → export → re-import → diff, run twice. The gate that says whether a
 * migration into this product and back out again is *understood*, which is a
 * weaker and far more useful claim than "lossless".
 *
 * **The gate does not assert that nothing is lost.** Three of the four targets
 * cannot round-trip losslessly and say so — that is what the fidelity tiers in
 * `export-port.ts` are for. A gate demanding equality would be red forever and
 * would therefore be switched off, taking the real signal with it. What it
 * asserts instead is that **everything lost was declared lost**: the diff
 * between the original IR and the re-imported one must be covered by the
 * exporter's own loss list. An undeclared loss is the defect — it means the
 * exporter's fidelity claim is wrong, and a consumer trusting that claim has
 * been misled.
 *
 * **Run twice, because the property that matters is a fixed point.** A lossy
 * round trip is fine if it settles: pass one drops what the target cannot hold,
 * and pass two changes nothing. A round trip that keeps losing on every pass is
 * a different thing entirely — the content decays each time it moves, and
 * nobody notices until the fourth migration. Comparing pass one against pass
 * two is the only way to tell those apart, and it is why the ADR says "run
 * twice" rather than "run".
 */

import type { ExportLoss, ToolExporter } from './export-port.js';
import type { IrNode } from './ir.js';

export interface RoundTripDifference {
  readonly nodeTitle: string;
  readonly field: string;
  /** What the original held, rendered for a human reading a gate failure. */
  readonly before: string;
  readonly after: string;
}

export interface RoundTripReport {
  readonly toolId: string;
  readonly fidelity: string;
  /** Differences between the original IR and the once-round-tripped IR. */
  readonly differences: readonly RoundTripDifference[];
  /** Differences the exporter declared it would cause. Expected, not failures. */
  readonly declared: readonly RoundTripDifference[];
  /** Differences nobody declared. These are the defect. */
  readonly undeclared: readonly RoundTripDifference[];
  /** True when pass two produced the same IR as pass one. */
  readonly stable: boolean;
  readonly passes: number;
  readonly ok: boolean;
}

/** The fields a round trip is compared on. */
const COMPARED = ['title', 'body', 'kind', 'preservedIdentifiers', 'relations'] as const;

function render(node: IrNode, field: (typeof COMPARED)[number]): string {
  const value = node[field];
  // Trimmed for the text fields. Every markdown writer ends a file with a
  // newline and every reader drops it; reporting that as a fidelity loss would
  // make all four exporters permanently red for a difference that is a property
  // of writing a file rather than of the content in it — and a gate that is red
  // for a reason nobody can act on is a gate that gets switched off.
  return typeof value === 'string' ? value.trim() : JSON.stringify(value);
}

/**
 * Compare two IR sets node by node, matched on title.
 *
 * Title rather than external ref, because the ref is *expected* to change: it
 * records where a node came from, and a re-import comes from the exported
 * snapshot rather than the original tool. Matching on it would report every
 * node as missing and the gate would say nothing useful.
 */
export function diffIr(
  before: readonly IrNode[],
  after: readonly IrNode[],
): readonly RoundTripDifference[] {
  const byTitle = new Map(after.map((node) => [node.title, node]));
  const differences: RoundTripDifference[] = [];

  for (const original of before) {
    const returned = byTitle.get(original.title);
    if (returned === undefined) {
      differences.push({
        nodeTitle: original.title,
        field: '(node)',
        before: 'present',
        after: 'missing',
      });
      continue;
    }
    for (const field of COMPARED) {
      const a = render(original, field);
      const b = render(returned, field);
      if (a !== b) differences.push({ nodeTitle: original.title, field, before: a, after: b });
    }
  }

  // Nodes the round trip *invented*. Rarer and worse than a loss: a consumer
  // reading the snapshot gets a requirement nobody wrote.
  const originals = new Set(before.map((node) => node.title));
  for (const returned of after) {
    if (!originals.has(returned.title)) {
      differences.push({
        nodeTitle: returned.title,
        field: '(node)',
        before: 'absent',
        after: 'invented',
      });
    }
  }

  return differences;
}

/**
 * Whether a difference is one the exporter told us to expect.
 *
 * Matched on node title and field. A loss declared against a different node's
 * field does not excuse this one — that would let a single declared loss
 * whitewash every difference in the document.
 */
export function isDeclared(
  difference: RoundTripDifference,
  losses: readonly ExportLoss[],
): boolean {
  return losses.some(
    (loss) => loss.nodeTitle === difference.nodeTitle && loss.field === difference.field,
  );
}

export interface RoundTripInput {
  readonly exporter: ToolExporter;
  readonly original: readonly IrNode[];
  /** Re-imports an exported snapshot back into IR. Injected so this stays pure. */
  readonly reimport: (files: readonly { path: string; contents: string }[]) => readonly IrNode[];
}

/**
 * Run the gate.
 *
 * Two passes, always. The second is not a retry — it is the measurement.
 */
export function roundTrip(input: RoundTripInput): RoundTripReport {
  const first = input.exporter.export(input.original);
  const afterOne = input.reimport(first.files);

  const second = input.exporter.export(afterOne);
  const afterTwo = input.reimport(second.files);

  const differences = diffIr(input.original, afterOne);
  const declared = differences.filter((difference) => isDeclared(difference, first.losses));
  const undeclared = differences.filter((difference) => !isDeclared(difference, first.losses));

  // Stability is pass-one against pass-two, not against the original. The
  // question is whether the transformation has settled, not whether it was
  // lossless — those are different properties and only one is achievable.
  const drift = diffIr(afterOne, afterTwo);

  return {
    toolId: input.exporter.toolId,
    fidelity: input.exporter.fidelity,
    differences,
    declared,
    undeclared,
    stable: drift.length === 0,
    passes: 2,
    ok: undeclared.length === 0 && drift.length === 0,
  };
}

export function formatRoundTrip(report: RoundTripReport): string {
  const lines = [
    `${report.toolId} (${report.fidelity}): ${String(report.differences.length)} difference(s) after a round trip, ${String(report.declared.length)} declared.`,
  ];

  if (!report.stable) {
    lines.push('');
    lines.push('UNSTABLE — a second round trip changed the result again. Content decays on every');
    lines.push('migration, and nobody notices until the fourth one.');
  }

  if (report.undeclared.length > 0) {
    lines.push('');
    lines.push(
      `${String(report.undeclared.length)} undeclared loss(es) — the fidelity claim is wrong:`,
    );
    for (const difference of report.undeclared.slice(0, 20)) {
      lines.push(
        `  ${difference.nodeTitle} · ${difference.field}: ${difference.before} -> ${difference.after}`,
      );
    }
  }

  if (report.ok) lines.push('', 'Every difference was declared, and the transformation is stable.');
  return lines.join('\n');
}

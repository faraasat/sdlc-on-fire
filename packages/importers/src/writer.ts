import { externalRefKey, WRITE_ORDER, type IrKind, type IrNode } from './ir.js';

/**
 * The transactional, dependency-ordered writer (P2-IMP-01, `.research/10 §3`).
 *
 * **Idempotency lives in the file, not in the database.** An import is keyed on
 * `external_ref` — `(source_tool, source_path, source_id_or_hash)` — and that key
 * is written into the card's frontmatter, where `db:rebuild` cannot erase it.
 * Had it lived only in a DB column, the first rebuild would forget every import
 * and the next run would duplicate the entire migration. This is the
 * content-in-git invariant doing real work rather than being recited.
 *
 * **Ordering is by kind, then by dependency within a kind.** A task whose parent
 * epic is in the same import must not be written first: the parent link would
 * point at nothing, and nothing downstream re-checks it.
 *
 * **A cycle is refused, not broken.** Picking an edge to ignore would produce a
 * plausible hierarchy that nobody chose, and the choice would be invisible in
 * the result. The import stops and names the cycle.
 */

/** What an import would do to one node, decided before anything is written. */
export type NodeAction = 'create' | 'update' | 'unchanged';

export interface PlannedNode {
  readonly node: IrNode;
  readonly key: string;
  readonly action: NodeAction;
  /** Why, in the words a report should use. */
  readonly reason: string;
}

export interface ImportPlan {
  readonly order: readonly PlannedNode[];
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Relations naming a node that is neither in this import nor already present. */
  readonly danglingRelations: readonly { readonly from: string; readonly to: string }[];
}

export class ImportCycleError extends Error {
  override readonly name = 'ImportCycleError';
  constructor(readonly cycle: readonly string[]) {
    super(
      `import refused: the source defines a parent cycle — ${cycle.join(' → ')}. ` +
        'Breaking it here would invent a hierarchy nobody chose, and the choice would ' +
        'not be visible in the result. Fix the source, then re-run.',
    );
  }
}

/**
 * What already exists in the target workspace, keyed by external ref.
 *
 * A content hash comes with it so an unchanged node can be told from a changed
 * one — the difference between a re-run that does nothing and one that
 * rewrites four hundred files with identical content and a new timestamp.
 */
export interface ExistingItem {
  readonly key: string;
  readonly contentHash: string;
}

/** Stable hash of what an import would actually write for a node. */
export function nodeContentHash(node: IrNode, hash: (input: string) => string): string {
  // Title and body only. `frontmatterHints` is a parser's opinion and the
  // writer may ignore it, so including it would report a change on a node whose
  // written form is byte-identical.
  return hash(`${node.title}\n\n${node.body}`);
}

function orderWithinKind(nodes: readonly IrNode[]): readonly IrNode[] {
  const byKey = new Map(nodes.map((node) => [externalRefKey(node.externalRef), node]));
  const out: IrNode[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (node: IrNode, trail: readonly string[]): void => {
    const key = externalRefKey(node.externalRef);
    const seen = state.get(key);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new ImportCycleError([...trail, key]);

    state.set(key, 'visiting');
    for (const relation of node.relations) {
      if (relation.type !== 'parent') continue;
      const parent = byKey.get(relation.targetExternalRef);
      // A parent outside this batch is either already written (an earlier kind,
      // or a previous import) or dangling — reported by the caller, not ordered
      // here. Only same-batch parents constrain the order.
      if (parent !== undefined) visit(parent, [...trail, key]);
    }
    state.set(key, 'done');
    out.push(node);
  };

  for (const node of nodes) visit(node, []);
  return out;
}

/**
 * Decides the whole import before writing any of it.
 *
 * This is what `--dry-run` reports, and it is the *same* computation the real
 * run uses — not a second implementation that predicts it. Two implementations
 * of "what would this import do" is how a dry-run comes to disagree with the
 * import it was supposed to preview.
 */
export function planImport(
  nodes: readonly IrNode[],
  existing: readonly ExistingItem[],
  hash: (input: string) => string,
): ImportPlan {
  const known = new Map(existing.map((item) => [item.key, item.contentHash]));
  const inBatch = new Set(nodes.map((node) => externalRefKey(node.externalRef)));

  const byKind = new Map<IrKind, IrNode[]>();
  for (const node of nodes) {
    const bucket = byKind.get(node.kind) ?? [];
    bucket.push(node);
    byKind.set(node.kind, bucket);
  }

  const order: PlannedNode[] = [];
  for (const kind of WRITE_ORDER) {
    for (const node of orderWithinKind(byKind.get(kind) ?? [])) {
      const key = externalRefKey(node.externalRef);
      const previous = known.get(key);
      const current = nodeContentHash(node, hash);

      const [action, reason]: [NodeAction, string] =
        previous === undefined
          ? ['create', 'not seen in any previous import']
          : previous === current
            ? ['unchanged', 'already imported and the source has not changed']
            : ['update', 'already imported, but the source content changed'];

      order.push({ node, key, action, reason });
    }
  }

  const danglingRelations = nodes.flatMap((node) =>
    node.relations
      .filter(
        (relation) =>
          !inBatch.has(relation.targetExternalRef) && !known.has(relation.targetExternalRef),
      )
      .map((relation) => ({
        from: externalRefKey(node.externalRef),
        to: relation.targetExternalRef,
      })),
  );

  return {
    order,
    created: order.filter((entry) => entry.action === 'create').length,
    updated: order.filter((entry) => entry.action === 'update').length,
    unchanged: order.filter((entry) => entry.action === 'unchanged').length,
    danglingRelations,
  };
}

export interface WriteOutcome {
  readonly key: string;
  readonly action: NodeAction;
  readonly error?: string | undefined;
}

export interface ImportResult {
  readonly plan: ImportPlan;
  readonly written: readonly WriteOutcome[];
  readonly committed: boolean;
}

/**
 * Applies a plan, all of it or none of it.
 *
 * The rollback is what makes "run it again" safe advice. A half-applied import
 * leaves a workspace in a state neither the source nor the target describes, and
 * the user's only recourse is reading four hundred files to find out which half
 * landed.
 *
 * `write` and `rollback` are supplied by the caller because *where* a node lands
 * is not this module's business — the same plan writes to a workspace, to a
 * temporary overlay, or to a dry-run report.
 */
export async function applyImport(
  plan: ImportPlan,
  write: (planned: PlannedNode) => Promise<void>,
  rollback: (applied: readonly WriteOutcome[]) => Promise<void>,
): Promise<ImportResult> {
  const written: WriteOutcome[] = [];

  for (const planned of plan.order) {
    if (planned.action === 'unchanged') {
      // The point of the idempotency key: a re-run after fixing one source file
      // touches that file, not the other three hundred and ninety-nine.
      written.push({ key: planned.key, action: 'unchanged' });
      continue;
    }
    try {
      await write(planned);
      written.push({ key: planned.key, action: planned.action });
    } catch (cause) {
      await rollback(written);
      return {
        plan,
        written: [...written, { key: planned.key, action: planned.action, error: String(cause) }],
        committed: false,
      };
    }
  }

  return { plan, written, committed: true };
}

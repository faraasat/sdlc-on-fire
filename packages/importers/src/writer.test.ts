import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { externalRefKey, IrNodeSchema, type IrNode } from './ir.js';
import {
  applyImport,
  ImportCycleError,
  planImport,
  type PlannedNode,
  type WriteOutcome,
} from './writer.js';

/**
 * P2-IMP-01 — the importer framework's two load-bearing promises: an import is
 * ordered so nothing points at something unwritten, and running it twice is
 * safe.
 *
 * Both promises are about *re-runs*, because that is what a real migration is:
 * import, notice one source file was wrong, fix it, import again. A framework
 * that duplicates four hundred items on the second run is not a migration path.
 */

const sha = (input: string): string => createHash('sha256').update(input).digest('hex');

const node = (over: Partial<IrNode> & Pick<IrNode, 'kind' | 'title'>): IrNode =>
  IrNodeSchema.parse({
    body: `Body of ${over.title}`,
    externalRef: {
      source_tool: 'openspec',
      source_path: `specs/${over.title}.md`,
      source_id_or_hash: over.title,
    },
    ...over,
  });

const keyOf = (n: IrNode): string => externalRefKey(n.externalRef);

describe('planImport — ordering', () => {
  it('writes kinds in dependency order, not source order', () => {
    const plan = planImport(
      [
        node({ kind: 'verification', title: 'V' }),
        node({ kind: 'task', title: 'T' }),
        node({ kind: 'constitution', title: 'C' }),
        node({ kind: 'epic', title: 'E' }),
      ],
      [],
      sha,
    );
    expect(plan.order.map((entry) => entry.node.kind)).toEqual([
      'constitution',
      'epic',
      'task',
      'verification',
    ]);
  });

  it('writes a parent before its child within the same kind', () => {
    const parent = node({ kind: 'task', title: 'parent' });
    const child = node({
      kind: 'task',
      title: 'child',
      relations: [{ type: 'parent', targetExternalRef: keyOf(parent) }],
    });

    // Child first in source order — the writer must not preserve it.
    const plan = planImport([child, parent], [], sha);
    const titles = plan.order.map((entry) => entry.node.title);
    expect(titles.indexOf('parent')).toBeLessThan(titles.indexOf('child'));
  });

  it('refuses a parent cycle rather than breaking it somewhere', () => {
    const a = node({ kind: 'task', title: 'A' });
    const b = node({ kind: 'task', title: 'B' });
    const cyclicA = { ...a, relations: [{ type: 'parent' as const, targetExternalRef: keyOf(b) }] };
    const cyclicB = { ...b, relations: [{ type: 'parent' as const, targetExternalRef: keyOf(a) }] };

    // Choosing an edge to ignore would produce a hierarchy nobody chose, and the
    // choice would be invisible in the imported result.
    expect(() => planImport([cyclicA, cyclicB], [], sha)).toThrow(ImportCycleError);
  });

  it('does not treat a parent from a previous import as a cycle or a dangle', () => {
    const child = node({
      kind: 'task',
      title: 'child',
      relations: [{ type: 'parent', targetExternalRef: 'openspec:specs/old.md:old' }],
    });
    const plan = planImport([child], [{ key: 'openspec:specs/old.md:old', contentHash: 'x' }], sha);
    expect(plan.danglingRelations).toEqual([]);
  });

  it('reports a relation that points at nothing, rather than dropping it', () => {
    const orphan = node({
      kind: 'task',
      title: 'orphan',
      relations: [{ type: 'parent', targetExternalRef: 'openspec:specs/ghost.md:ghost' }],
    });
    const plan = planImport([orphan], [], sha);
    // Silently discarding the edge would lose the one signal that the source
    // tree was incomplete — and the import would look clean.
    expect(plan.danglingRelations).toEqual([
      { from: keyOf(orphan), to: 'openspec:specs/ghost.md:ghost' },
    ]);
  });
});

describe('planImport — external_ref idempotency', () => {
  const original = node({ kind: 'task', title: 'T' });

  it('creates what it has never seen', () => {
    expect(planImport([original], [], sha).order[0]?.action).toBe('create');
  });

  it('leaves an already-imported, unchanged node alone', () => {
    const existing = [{ key: keyOf(original), contentHash: sha(`T\n\n${original.body}`) }];
    const plan = planImport([original], existing, sha);
    // The mechanism that makes "fix one file and re-run" cheap. Without it the
    // second run rewrites everything with a fresh timestamp and the diff is
    // four hundred files of noise.
    expect(plan.order[0]?.action).toBe('unchanged');
    expect(plan.unchanged).toBe(1);
  });

  it('updates when the source content changed, rather than duplicating', () => {
    const existing = [{ key: keyOf(original), contentHash: sha('T\n\nsomething older') }];
    const plan = planImport([original], existing, sha);
    expect(plan.order[0]?.action).toBe('update');
    // One entry, not two: the same source node re-imported is the same item.
    expect(plan.order).toHaveLength(1);
  });

  it('keys on the full external ref, so two tools cannot collide', () => {
    // `FR-003` from Spec Kit and `FR-003` from GSD are unrelated items that
    // look identical (.research/10 §5). The source tool is part of the key.
    const fromSpecKit = node({
      kind: 'task',
      title: 'FR-003',
      externalRef: { source_tool: 'speckit', source_path: 'spec.md', source_id_or_hash: 'FR-003' },
    });
    const fromGsd = node({
      kind: 'task',
      title: 'FR-003',
      externalRef: { source_tool: 'gsd', source_path: 'spec.md', source_id_or_hash: 'FR-003' },
    });
    const plan = planImport([fromSpecKit, fromGsd], [], sha);
    expect(plan.created).toBe(2);
  });
});

describe('applyImport', () => {
  const two = [node({ kind: 'task', title: 'A' }), node({ kind: 'task', title: 'B' })];

  it('writes every planned node and commits', async () => {
    const written: string[] = [];
    const result = await applyImport(
      planImport(two, [], sha),
      (planned: PlannedNode) => {
        written.push(planned.node.title);
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    expect(result.committed).toBe(true);
    expect(written).toEqual(['A', 'B']);
  });

  it('rolls back everything already written when one write fails', async () => {
    const written: string[] = [];
    let rolledBack: readonly WriteOutcome[] = [];

    const result = await applyImport(
      planImport(two, [], sha),
      (planned: PlannedNode) => {
        if (planned.node.title === 'B') return Promise.reject(new Error('disk full'));
        written.push(planned.node.title);
        return Promise.resolve();
      },
      (applied) => {
        rolledBack = applied;
        return Promise.resolve();
      },
    );

    // A half-applied import leaves a workspace in a state neither the source nor
    // the target describes, and the only recourse is reading every file to find
    // out which half landed.
    expect(result.committed).toBe(false);
    expect(rolledBack.map((entry) => entry.key)).toEqual([keyOf(two[0] as IrNode)]);
    expect(result.written.at(-1)?.error).toContain('disk full');
  });

  it('does not call the writer for an unchanged node', async () => {
    const existing = two.map((n) => ({
      key: keyOf(n),
      contentHash: sha(`${n.title}\n\n${n.body}`),
    }));
    let writes = 0;
    const result = await applyImport(
      planImport(two, existing, sha),
      () => {
        writes += 1;
        return Promise.resolve();
      },
      () => Promise.resolve(),
    );
    expect(writes).toBe(0);
    expect(result.committed).toBe(true);
  });
});

describe('the IR itself', () => {
  it('refuses a node carrying an unknown field', () => {
    // Strict, because a parser silently attaching a field the writer ignores is
    // data loss that looks like a successful import.
    expect(() =>
      IrNodeSchema.parse({
        kind: 'task',
        title: 'T',
        body: '',
        externalRef: { source_tool: 'gsd', source_path: 'p', source_id_or_hash: 'h' },
        notAField: true,
      }),
    ).toThrow();
  });

  it('keeps source identifiers verbatim', () => {
    const parsed = IrNodeSchema.parse({
      kind: 'task',
      title: 'T',
      body: '',
      externalRef: { source_tool: 'speckit', source_path: 'p', source_id_or_hash: 'FR-003' },
      preservedIdentifiers: ['FR-003', 'SC-001'],
    });
    // Teams reference these in commits and PRs. Renumbering breaks every one of
    // those references, and the breakage shows up as a human misreading a PR.
    expect(parsed.preservedIdentifiers).toEqual(['FR-003', 'SC-001']);
  });
});

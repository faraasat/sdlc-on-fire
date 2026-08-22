import { describe, expect, it } from 'vitest';
import { EXPORTERS, openSpecExporter } from './exporters.js';
import { diffIr, isDeclared, roundTrip, type RoundTripInput } from './round-trip.js';
import type { IrNode } from './ir.js';

/**
 * P2-IMP-08 — the round-trip fidelity gate.
 *
 * Unblocked by P4-EXP-01, which built the export half this needed.
 *
 * The gate does not assert losslessness — three of the four targets cannot
 * round-trip and say so. It asserts that everything lost was **declared** lost,
 * and that the transformation **settles**. A gate demanding equality would be
 * red forever and would be switched off, taking the real signal with it.
 */

const node = (over: Partial<IrNode> = {}): IrNode => ({
  kind: 'spec',
  title: 'Retry policy',
  body: 'Retries stop at 3.',
  frontmatterHints: {},
  externalRef: { source_tool: 'openspec', source_path: 'specs/a/spec.md', source_id_or_hash: 'h' },
  preservedIdentifiers: ['FR-1'],
  relations: [],
  ...over,
});

/** A re-importer that reads back exactly what the exporter wrote. */
const faithfulReimport = (files: readonly { path: string; contents: string }[]): IrNode[] =>
  files.map((file) => {
    const title = /^#\s+(.+)$/m.exec(file.contents)?.[1] ?? '';
    const identifiers = /^identifiers:\s*\[(.+)\]$/m.exec(file.contents)?.[1];
    const body = file.contents.split(/^#\s+.+$/m)[1]?.trim() ?? '';
    return node({
      title,
      body,
      preservedIdentifiers:
        identifiers === undefined ? [] : identifiers.split(',').map((s) => s.trim()),
    });
  });

describe('diffIr', () => {
  it('finds nothing between identical sets', () => {
    expect(diffIr([node()], [node()])).toEqual([]);
  });

  it('reports a missing node', () => {
    const difference = diffIr([node()], [])[0];
    expect(difference?.field).toBe('(node)');
    expect(difference?.after).toBe('missing');
  });

  it('reports an invented node, which is worse than a loss', () => {
    // A consumer reading the snapshot gets a requirement nobody wrote.
    const difference = diffIr([], [node()])[0];
    expect(difference?.after).toBe('invented');
  });

  it('reports a changed field with both values', () => {
    const difference = diffIr([node()], [node({ body: 'changed' })])[0];
    expect(difference?.field).toBe('body');
    expect(difference?.before).toContain('Retries stop at 3');
    expect(difference?.after).toBe('changed');
  });

  it('matches on title, not external ref', () => {
    // The ref is *expected* to change: it records where a node came from, and a
    // re-import comes from the snapshot rather than the original tool. Matching
    // on it would report every node as missing and say nothing useful.
    const moved = node({
      externalRef: { source_tool: 'x', source_path: 'y', source_id_or_hash: 'z' },
    });
    expect(diffIr([node()], [moved])).toEqual([]);
  });

  it('reports dropped identifiers, which references depend on', () => {
    const difference = diffIr([node()], [node({ preservedIdentifiers: [] })])[0];
    expect(difference?.field).toBe('preservedIdentifiers');
  });
});

describe('isDeclared', () => {
  const difference = { nodeTitle: 'A', field: 'relations', before: 'x', after: 'y' };

  it('accepts a loss declared for that node and field', () => {
    expect(
      isDeclared(difference, [{ nodeTitle: 'A', kind: 'spec', field: 'relations', because: '' }]),
    ).toBe(true);
  });

  it('does not let one node’s declared loss excuse another’s', () => {
    // Otherwise a single declared loss whitewashes every difference in the
    // document.
    expect(
      isDeclared(difference, [{ nodeTitle: 'B', kind: 'spec', field: 'relations', because: '' }]),
    ).toBe(false);
  });

  it('does not let a declared loss on one field excuse another field', () => {
    expect(
      isDeclared(difference, [{ nodeTitle: 'A', kind: 'spec', field: 'body', because: '' }]),
    ).toBe(false);
  });
});

describe('roundTrip', () => {
  const run = (over: Partial<RoundTripInput> = {}) =>
    roundTrip({
      exporter: openSpecExporter,
      original: [node()],
      reimport: faithfulReimport,
      ...over,
    });

  it('runs exactly two passes, because the second is the measurement', () => {
    expect(run().passes).toBe(2);
  });

  it('passes when every difference was declared and the result settles', () => {
    const report = run();
    expect(report.undeclared).toEqual([]);
    expect(report.stable).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('fails on an undeclared loss, which means the fidelity claim is wrong', () => {
    // A consumer trusting the tier has been misled.
    const report = run({
      reimport: (files) =>
        faithfulReimport(files).map((n) => ({ ...n, body: 'silently rewritten' })),
    });
    expect(report.undeclared.some((d) => d.field === 'body')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('fails an unstable round trip whose FIRST pass was clean', () => {
    // The reason the ADR says "run twice", isolated properly. An earlier
    // version of this test decayed on every pass, so pass one already produced
    // undeclared losses and the assertion held even with the stability check
    // deleted — it passed for the wrong reason.
    //
    // Here pass one is byte-clean and only pass two drifts, so `undeclared` is
    // empty and the stability comparison is the *only* thing that can fail the
    // gate. A transformation like this decays content on every migration and
    // nobody notices until the fourth one.
    let call = 0;
    const cleanThenDrifting = (files: readonly { path: string; contents: string }[]): IrNode[] => {
      call += 1;
      const parsed = faithfulReimport(files);
      return call === 1 ? parsed : parsed.map((n) => ({ ...n, body: `${n.body} decayed` }));
    };
    const report = run({ reimport: cleanThenDrifting });

    expect(report.undeclared, 'pass one must be clean, or this tests the wrong thing').toEqual([]);
    expect(report.stable).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('does not demand losslessness from a lossy tier', () => {
    // Three of the four targets cannot round-trip. A gate demanding equality
    // would be red forever and would get switched off.
    const report = run({
      original: [node({ relations: [{ type: 'blocks', targetExternalRef: 'x:y:z' }] })],
    });
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.declared.length).toBeGreaterThan(0);
  });

  it('reports the tier alongside the result', () => {
    expect(run().fidelity).toBe('high');
  });

  it('runs for every exporter without throwing', () => {
    for (const exporter of EXPORTERS) {
      const supported = exporter.supports.map((kind) => node({ kind, title: `${kind} doc` }));
      expect(() =>
        roundTrip({ exporter, original: supported, reimport: faithfulReimport }),
      ).not.toThrow();
    }
  });
});

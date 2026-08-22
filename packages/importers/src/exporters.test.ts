import { describe, expect, it } from 'vitest';
import {
  EXPORTERS,
  bmadExporter,
  exporterFor,
  gsdExporter,
  openSpecExporter,
  specKitExporter,
} from './exporters.js';
import { fidelityViolations, slugify, unsupported } from './export-port.js';
import type { IrNode } from './ir.js';

/**
 * P4-EXP-01 — round-trip export snapshots.
 *
 * The failure this whole module is arranged to prevent is an export that looks
 * complete, imports cleanly, and is quietly missing the relations. So the
 * assertions are mostly about *what was reported as lost*, not about what was
 * written — a value that cannot be represented must be recorded, never dropped.
 */

const node = (over: Partial<IrNode> = {}): IrNode => ({
  kind: 'spec',
  title: 'Retry policy',
  body: 'Retries are bounded at 3.',
  frontmatterHints: {},
  externalRef: {
    source_tool: 'openspec',
    source_path: 'specs/retry/spec.md',
    source_id_or_hash: 'h1',
  },
  preservedIdentifiers: [],
  relations: [],
  ...over,
});

describe('every exporter', () => {
  it('declares a tier, a dialect and the kinds it supports', () => {
    for (const exporter of EXPORTERS) {
      expect(exporter.toolId).not.toBe('');
      expect(exporter.supports.length).toBeGreaterThan(0);
    }
  });

  it('meets the fidelity tier it claims', () => {
    // The deterministic disposer (ADR-0040): the claim is checked against the
    // output rather than asserted beside it.
    for (const exporter of EXPORTERS) {
      const supported = exporter.supports.map((kind) => node({ kind, title: `${kind} doc` }));
      const result = exporter.export(supported);
      expect(
        fidelityViolations(result),
        `${exporter.toolId}: ${fidelityViolations(result).join('; ')}`,
      ).toEqual([]);
    }
  });

  it('emits byte-stable output for reordered input', () => {
    // The snapshot gets diffed against a previous one. Ordering that followed
    // input order would produce a diff whenever rows came back differently.
    for (const exporter of EXPORTERS) {
      const nodes = exporter.supports.map((kind) => node({ kind, title: `${kind} thing` }));
      const forward = exporter.export(nodes).files.map((f) => f.path);
      const reversed = exporter.export([...nodes].reverse()).files.map((f) => f.path);
      expect(reversed).toEqual(forward);
    }
  });

  it('reports a kind it cannot represent rather than dropping it silently', () => {
    const result = gsdExporter.export([node({ kind: 'spec' })]);
    expect(result.unsupportedKinds).toContain('spec');
    expect(result.files).toEqual([]);
  });

  it('never writes a file for an unsupported kind', () => {
    for (const exporter of EXPORTERS) {
      const alien = node({ kind: 'verification', title: 'V' });
      const result = exporter.export([alien]);
      if (!exporter.supports.includes('verification')) expect(result.files).toEqual([]);
    }
  });
});

describe('openSpecExporter', () => {
  it('keeps delta-of, because OpenSpec has the concept', () => {
    const result = openSpecExporter.export([
      node({
        kind: 'change',
        title: 'Add retries',
        relations: [{ type: 'delta-of', targetExternalRef: 'openspec:specs/retry/spec.md:h1' }],
      }),
    ]);
    expect(result.files[0]?.contents).toContain('delta-of:');
    expect(result.losses).toEqual([]);
  });

  it('reports the relation types OpenSpec cannot hold', () => {
    const result = openSpecExporter.export([
      node({ relations: [{ type: 'blocks', targetExternalRef: 'x:y:z' }] }),
    ]);
    expect(result.losses.map((l) => l.field)).toContain('relations');
    expect(result.losses[0]?.because).toContain('blocks');
  });

  it('is no longer high fidelity once it drops something', () => {
    // A `high` exporter that drops a relation is a bug it reports about itself.
    const result = openSpecExporter.export([
      node({ relations: [{ type: 'blocks', targetExternalRef: 'x:y:z' }] }),
    ]);
    expect(fidelityViolations(result)).not.toEqual([]);
  });

  it('writes preserved identifiers verbatim, never renumbered', () => {
    // Teams reference these in commits and PRs; renumbering breaks every one of
    // those references and surfaces as a human misreading a PR.
    const result = openSpecExporter.export([node({ preservedIdentifiers: ['FR-003', 'SC-001'] })]);
    expect(result.files[0]?.contents).toContain('FR-003');
    expect(result.files[0]?.contents).toContain('SC-001');
  });

  it('puts specs, changes and the constitution where OpenSpec looks for them', () => {
    const paths = openSpecExporter
      .export([
        node({ kind: 'spec' }),
        node({ kind: 'change', title: 'C' }),
        node({ kind: 'constitution', title: 'P' }),
      ])
      .files.map((f) => f.path);
    expect(paths).toContain('openspec/specs/retry-policy/spec.md');
    expect(paths).toContain('openspec/changes/c/proposal.md');
    expect(paths).toContain('openspec/project.md');
  });
});

describe('the moderate and best-effort tiers', () => {
  it('speckit reports the graph it cannot represent', () => {
    const result = specKitExporter.export([
      node({ relations: [{ type: 'parent', targetExternalRef: 'x:y:z' }] }),
    ]);
    expect(result.losses.map((l) => l.field)).toContain('relations');
    // Moderate allows dropping fields, so this is still within tier.
    expect(fidelityViolations(result)).toEqual([]);
  });

  it('gsd reports frontmatter it has nowhere to put', () => {
    const result = gsdExporter.export([node({ kind: 'task', frontmatterHints: { owner: 'ana' } })]);
    expect(result.losses.map((l) => l.field)).toContain('frontmatterHints');
  });

  it('bmad reports that identifiers survive only in prose', () => {
    const result = bmadExporter.export([node({ kind: 'epic', preservedIdentifiers: ['FR-1'] })]);
    expect(result.losses.map((l) => l.field)).toContain('preservedIdentifiers');
  });

  it('records external-ref loss everywhere it is not representable', () => {
    for (const exporter of [specKitExporter, gsdExporter, bmadExporter]) {
      const kind = exporter.supports[0] ?? 'spec';
      const result = exporter.export([node({ kind })]);
      expect(result.losses.map((l) => l.field)).toContain('externalRef');
    }
  });
});

describe('fidelityViolations', () => {
  const base = {
    toolId: 't',
    dialect: 'd',
    files: [{ path: 'a', contents: 'b' }],
    losses: [],
    unsupportedKinds: [],
  };

  it('accepts a high export that lost nothing', () => {
    expect(fidelityViolations({ ...base, fidelity: 'high' })).toEqual([]);
  });

  it('rejects a high export that lost something, and names the fields', () => {
    const violations = fidelityViolations({
      ...base,
      fidelity: 'high',
      losses: [{ nodeTitle: 'n', kind: 'spec', field: 'relations', because: 'x' }],
    });
    expect(violations[0]).toContain('relations');
  });

  it('does not count an unrepresentable kind against any tier', () => {
    // Corrected after running the exporter over a realistic workspace. Treating
    // this as a violation meant one epic on the board made a `high` OpenSpec
    // export refuse to write anything — for a reason that is a property of
    // OpenSpec rather than an infidelity in what was written. The tier is about
    // how faithfully the representable nodes were represented; what the format
    // cannot hold is reported separately, always.
    for (const fidelity of ['high', 'moderate', 'best-effort'] as const) {
      expect(fidelityViolations({ ...base, fidelity, unsupportedKinds: ['task'] })).toEqual([]);
    }
  });

  it('still reports the unrepresentable kinds, so nothing is hidden', () => {
    const result = gsdExporter.export([node({ kind: 'spec' }), node({ kind: 'task', title: 'T' })]);
    expect(result.unsupportedKinds).toEqual(['spec']);
    expect(fidelityViolations(result)).toEqual([]);
  });

  it('flags an export that produced nothing and reported nothing', () => {
    // Silent failure and an empty project look identical from the outside.
    expect(fidelityViolations({ ...base, fidelity: 'high', files: [] })[0]).toContain(
      'nothing to distinguish',
    );
  });
});

describe('slugify', () => {
  it('makes a filename-safe slug', () => {
    expect(slugify('Retry policy: bounded!')).toBe('retry-policy-bounded');
  });

  it('never returns an empty string', () => {
    expect(slugify('!!!')).toBe('untitled');
  });
});

describe('unsupported', () => {
  it('lists each missing kind once, sorted', () => {
    const kinds = unsupported(
      [node({ kind: 'task' }), node({ kind: 'epic' }), node({ kind: 'task' })],
      ['spec'],
    );
    expect(kinds).toEqual(['epic', 'task']);
  });
});

describe('exporterFor', () => {
  it('finds a known tool and returns undefined for an unknown one', () => {
    expect(exporterFor('openspec')).toBe(openSpecExporter);
    expect(exporterFor('jira')).toBeUndefined();
  });
});

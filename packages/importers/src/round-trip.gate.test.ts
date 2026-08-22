import { describe, expect, it } from 'vitest';
import { EXPORTERS } from './exporters.js';
import { formatRoundTrip, roundTrip } from './round-trip.js';
import { splitRequirements } from './openspec.js';
import type { IrNode } from './ir.js';

/**
 * The round-trip fidelity gate itself (P2-IMP-08).
 *
 * `round-trip.test.ts` proves the mechanism against injected re-importers. This
 * runs it over **every exporter with the real re-import path**, and it is the
 * thing that actually gates: a gate that exists and is called by nothing looks
 * identical to a gate that passes, which is the defect this repo has now found
 * in four separate places.
 *
 * It lives in the test suite rather than in a separate CI script on purpose.
 * `pnpm check` runs it on every change, so an exporter whose fidelity claim
 * drifts is caught by the same command that catches a type error — rather than
 * by a workflow somebody has to remember to keep enabled.
 */

const corpus: readonly IrNode[] = [
  {
    kind: 'spec',
    title: 'Retries are bounded',
    body: '### Requirement: Retries are bounded\n\nThe system MUST retry at most three times.\n',
    frontmatterHints: {},
    externalRef: {
      source_tool: 'sdlc-on-fire',
      source_path: 'specs/retry/spec.md',
      source_id_or_hash: 'h1',
    },
    preservedIdentifiers: ['FR-001'],
    relations: [],
  },
  {
    kind: 'change',
    title: 'Add a retry budget',
    body: '## ADDED Requirements\n\n### Requirement: Budgeted retries\n\nIt MUST stop at three.\n',
    frontmatterHints: {},
    externalRef: {
      source_tool: 'sdlc-on-fire',
      source_path: 'changes/budget/proposal.md',
      source_id_or_hash: 'h2',
    },
    preservedIdentifiers: ['FR-002'],
    relations: [{ type: 'delta-of', targetExternalRef: 'sdlc-on-fire:specs/retry/spec.md:h1' }],
  },
  {
    kind: 'constitution',
    title: 'Project principles',
    body: 'Evidence over assertion.\n',
    frontmatterHints: {},
    externalRef: {
      source_tool: 'sdlc-on-fire',
      source_path: 'project.md',
      source_id_or_hash: 'h3',
    },
    preservedIdentifiers: [],
    relations: [],
  },
  {
    kind: 'epic',
    title: 'Reliability work',
    body: 'Make it not fall over.\n',
    frontmatterHints: {},
    externalRef: {
      source_tool: 'sdlc-on-fire',
      source_path: 'kanban/EPIC-1.md',
      source_id_or_hash: 'h4',
    },
    preservedIdentifiers: ['EPIC-1'],
    relations: [],
  },
];

/**
 * Re-import a snapshot the way a parser actually would: from the emitted text.
 *
 * Frontmatter is read back for the fields the exporters put there, and the body
 * is whatever follows the heading. Deliberately naive — a generous re-importer
 * would hide exactly the losses this gate exists to surface.
 */
function reimport(files: readonly { path: string; contents: string }[]): IrNode[] {
  return files.map((file) => {
    const title = /^#\s+(.+)$/m.exec(file.contents)?.[1]?.trim() ?? '';
    // Both spellings: OpenSpec writes `identifiers:`, Spec Kit writes
    // `requirements:`. Reading only one would report Spec Kit as losing the ids
    // it in fact wrote down — a false failure, which is as corrosive to a gate
    // as a missed one.
    const identifiers =
      /^identifiers:\s*\[(.*)\]$/m.exec(file.contents)?.[1] ??
      /^requirements:\s*\[(.*)\]$/m.exec(file.contents)?.[1];
    const deltas = /^delta-of:\s*\[(.*)\]$/m.exec(file.contents)?.[1];
    const afterHeading = file.contents.split(/^#\s+.+$/m)[1] ?? '';

    return {
      // Kind is recovered from the path the exporter chose, which is the only
      // place it survives — none of these formats records our kind vocabulary.
      // Recovered from the path, which is the only place it survives — none of
      // these formats records our kind vocabulary. BMAD encodes it as a
      // filename prefix (`docs/epic-slug.md`), GSD as a directory.
      // `s?` because GSD pluralises the directory (`.gsd/epics/`) while BMAD
      // uses a singular filename prefix (`docs/epic-…`). Missing it made the
      // gate report a real GSD epic as a spec, which then exported to a
      // different path on pass two and showed up as instability — one failure
      // wearing two hats.
      kind:
        (/(?:^|\/)(epic|story|task|spec|change|constitution)s?[-/]/.exec(file.path)?.[1] as
          IrNode['kind'] | undefined) ??
        (file.path.includes('/changes/')
          ? ('change' as const)
          : file.path.includes('project.md') || file.path.includes('constitution')
            ? ('constitution' as const)
            : ('spec' as const)),
      title,
      body: afterHeading.trim(),
      frontmatterHints: {},
      externalRef: { source_tool: 'reimport', source_path: file.path, source_id_or_hash: 'r' },
      preservedIdentifiers:
        identifiers === undefined || identifiers.trim() === ''
          ? []
          : identifiers.split(',').map((entry) => entry.trim()),
      relations:
        deltas === undefined || deltas.trim() === ''
          ? []
          : deltas
              .split(',')
              .map((entry) => ({ type: 'delta-of' as const, targetExternalRef: entry.trim() })),
    };
  });
}

describe('round-trip fidelity gate', () => {
  for (const exporter of EXPORTERS) {
    describe(exporter.toolId, () => {
      const supported = corpus.filter((node) => exporter.supports.includes(node.kind));
      const report = roundTrip({ exporter, original: supported, reimport });

      it('settles — a second round trip changes nothing', () => {
        // The property that separates "lossy but understood" from "decaying".
        expect(report.stable, formatRoundTrip(report)).toBe(true);
      });

      it('declares every loss it causes', () => {
        // Not losslessness. An undeclared loss means the fidelity claim is
        // wrong and a consumer trusting the tier has been misled.
        expect(report.undeclared, formatRoundTrip(report)).toEqual([]);
      });

      it('invents nothing', () => {
        const invented = report.differences.filter((d) => d.after === 'invented');
        expect(invented, formatRoundTrip(report)).toEqual([]);
      });
    });
  }

  it('emits requirements our own OpenSpec parser can read back', () => {
    // The native format *is* the delta model (P4-BROWN-01), so a document we
    // export must survive our own importer's grammar. If this ever fails, the
    // two have diverged and one of them is wrong.
    const openspec = EXPORTERS.find((e) => e.toolId === 'openspec');
    const result = openspec?.export(corpus.filter((n) => n.kind === 'change'));
    const contents = result?.files[0]?.contents ?? '';
    expect(splitRequirements(contents).map((r) => r.title)).toContain('Budgeted retries');
  });
});

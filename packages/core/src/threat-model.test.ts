import { describe, expect, it } from 'vitest';
import {
  evaluateThreatModel,
  formatThreatModel,
  requiredCells,
  STRIDE_CATEGORIES,
  type ThreatEntry,
  type ToolSurface,
} from './threat-model.js';

/**
 * P2-SEC-06 — per-tool-surface threat modelling.
 *
 * The gate is on **coverage, not content**. These tests are written from that:
 * they check that a cell cannot be skipped or faked, and they never assert that
 * any particular reasoning is correct — which is the reviewer's judgement, not
 * a checker's.
 */

const surface: ToolSurface = {
  name: 'mcp-client',
  layers: ['agent-frameworks', 'agent-ecosystem'],
  components: ['transport', 'tool-registry'],
};

const full = (disposition: ThreatEntry['disposition'] = 'mitigated'): ThreatEntry[] =>
  surface.components.flatMap((component) =>
    STRIDE_CATEGORIES.map((category) => ({
      component,
      category,
      disposition,
      rationale: `handled by the ${component} boundary check`,
    })),
  );

describe('requiredCells', () => {
  it('is every component crossed with every STRIDE category', () => {
    expect(requiredCells(surface)).toHaveLength(2 * STRIDE_CATEGORIES.length);
  });

  it('is empty when no component is declared', () => {
    expect(requiredCells({ ...surface, components: [] })).toEqual([]);
  });
});

describe('evaluateThreatModel', () => {
  it('passes a fully dispositioned grid', () => {
    const result = evaluateThreatModel(surface, full());
    expect(result.complete).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.answered).toBe(result.required);
  });

  it('fails when a cell is missing', () => {
    const entries = full().slice(0, -1);
    const result = evaluateThreatModel(surface, entries);
    // The whole point: a model can draft every answer, but it cannot skip a
    // cell, because the checker counts cells rather than reading prose.
    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.reason).toContain('no disposition');
  });

  it('fails a cell answered without a rationale', () => {
    const entries = full();
    entries[0] = { ...entries[0]!, rationale: 'n/a' };
    const result = evaluateThreatModel(surface, entries);
    // An empty rationale is an unanswered cell wearing an answer's clothes,
    // and it is worse than a blank because it reads as covered.
    expect(result.complete).toBe(false);
    expect(result.gaps[0]?.reason).toContain('no rationale');
  });

  it('requires a rationale even for not-applicable', () => {
    const entries = full('not-applicable').map((entry) => ({ ...entry, rationale: '-' }));
    expect(evaluateThreatModel(surface, entries).complete).toBe(false);
  });

  it('accepts not-applicable when it is explained', () => {
    const result = evaluateThreatModel(surface, full('not-applicable'));
    expect(result.complete).toBe(true);
  });

  it('treats accepted as a real outcome, not a failure', () => {
    const result = evaluateThreatModel(surface, full('accepted'));
    // A threat model where everything must be mitigated is one people fill in
    // dishonestly. Recording that a risk was seen and knowingly taken is more
    // useful than a form where every box is green.
    expect(result.complete).toBe(true);
    expect(result.accepted).toHaveLength(result.required);
  });

  it('surfaces accepted risks rather than burying them', () => {
    const entries = full();
    entries[0] = { ...entries[0]!, disposition: 'accepted', rationale: 'no auth on localhost yet' };
    const result = evaluateThreatModel(surface, entries);
    // The part somebody should re-read in six months, and the part that
    // silently becomes untrue.
    expect(result.accepted).toHaveLength(1);
    expect(formatThreatModel(result)).toContain('no auth on localhost yet');
  });

  it('does not count an entry for a component that is not in the grid', () => {
    const entries = [
      ...full(),
      {
        component: 'not-a-component',
        category: 'spoofing' as const,
        disposition: 'mitigated' as const,
        rationale: 'this component does not exist on this surface',
      },
    ];
    const result = evaluateThreatModel(surface, entries);
    // Padding the answer set must not be able to raise the coverage count.
    expect(result.answered).toBe(result.required);
  });

  it('is not complete for a surface with no components', () => {
    const result = evaluateThreatModel({ ...surface, components: [] }, []);
    // An empty grid trivially has no gaps. Calling that complete would let a
    // surface pass by declaring nothing.
    expect(result.complete).toBe(false);
  });
});

describe('formatThreatModel', () => {
  it('says an empty grid is not a clean one', () => {
    const text = formatThreatModel(evaluateThreatModel({ ...surface, components: [] }, []));
    expect(text).toContain('an empty grid is not a');
  });

  it('lists the unanswered cells', () => {
    const result = evaluateThreatModel(surface, full().slice(0, 3));
    const text = formatThreatModel(result);
    expect(text).toContain('unanswered');
    expect(text).toContain('tool-registry');
  });

  it('truncates a long gap list rather than printing hundreds of lines', () => {
    const wide: ToolSurface = {
      ...surface,
      components: Array.from({ length: 10 }, (_, i) => `component-${String(i)}`),
    };
    const text = formatThreatModel(evaluateThreatModel(wide, []));
    expect(text).toContain('and 40 more');
  });
});

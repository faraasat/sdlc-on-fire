import { describe, expect, it } from 'vitest';
import { CONTEXT_LAYER_KINDS } from './context.js';
import {
  admitContextOrigin,
  checkLayerProvenance,
  checkPackProvenance,
  CONTEXT_ORIGINS,
  LAYER_ORIGIN,
  UI_ORIGINS,
} from './context-provenance.js';

/**
 * P3-UI-02 — the agent-context firewall (ADR-0016).
 *
 * The rule is that a human's intent reaches an agent only after being persisted
 * through the daemon, where it gains an author and a row. ADR-0016 states it;
 * these make it fail. A rule nothing checks is a comment.
 */

describe('admitContextOrigin', () => {
  it('admits every persisted origin', () => {
    for (const origin of CONTEXT_ORIGINS) {
      expect(admitContextOrigin(origin).admitted, origin).toBe(true);
    }
  });

  it('refuses every UI origin, and says what to do instead', () => {
    // A filter value has no author, no timestamp and no durable record. An
    // agent acting on it would be acting on something nobody can trace and
    // that vanishes when the tab closes — while the pack still looks complete.
    for (const origin of UI_ORIGINS) {
      const verdict = admitContextOrigin(origin);
      expect(verdict.admitted, origin).toBe(false);
      expect(verdict.refusal, origin).toBe('ui-state');
      expect(verdict.because, origin).toMatch(/persist it as a comment/i);
    }
  });

  it('refuses an absent origin rather than defaulting to an allowed one', () => {
    // Defaulting would make the check pass for exactly the segments nobody
    // thought about, which is where a leak comes from.
    for (const origin of [undefined, null, '', '   ']) {
      const verdict = admitContextOrigin(origin);
      expect(verdict.admitted, String(origin)).toBe(false);
      expect(verdict.refusal, String(origin)).toBe('no-origin');
    }
  });

  it('refuses an origin it does not recognise', () => {
    expect(admitContextOrigin('scraped-from-somewhere').refusal).toBe('unknown-origin');
  });

  it('keeps "this is UI state" distinguishable from "I do not know this"', () => {
    // They need different messages: one is a design error with a clear fix, the
    // other is a typo or a new source nobody has classified.
    expect(admitContextOrigin('ui-filter').refusal).toBe('ui-state');
    expect(admitContextOrigin('ui-something-new').refusal).toBe('unknown-origin');
  });

  it('tolerates surrounding whitespace', () => {
    expect(admitContextOrigin('  card  ').admitted).toBe(true);
    expect(admitContextOrigin('  ui-draft  ').refusal).toBe('ui-state');
  });
});

describe('checkPackProvenance', () => {
  it('reports every violation, not the first', () => {
    // Fixing one and finding the next makes a list of problems look like
    // whack-a-mole.
    const violations = checkPackProvenance([
      { origin: 'card', label: 'a' },
      { origin: 'ui-filter', label: 'b' },
      { origin: 'ui-draft', label: 'c' },
    ]);
    expect(violations.map((violation) => violation.label)).toEqual(['b', 'c']);
  });

  it('is silent on a clean pack', () => {
    expect(checkPackProvenance([{ origin: 'card' }, { origin: 'retrieval' }])).toEqual([]);
  });

  it('locates a violation even without a label', () => {
    expect(checkPackProvenance([{ origin: 'ui-state' }])[0]?.label).toContain('segment');
  });
});

describe('LAYER_ORIGIN', () => {
  it('covers every context layer kind, with no gaps', () => {
    // The totality is the enforcement: adding a layer without saying where it
    // comes from is a type error at the point the layer is declared, rather
    // than a runtime check somebody has to remember to call.
    for (const kind of CONTEXT_LAYER_KINDS) {
      expect(LAYER_ORIGIN[kind], kind).toBeDefined();
      expect(admitContextOrigin(LAYER_ORIGIN[kind]).admitted, kind).toBe(true);
    }
    expect(Object.keys(LAYER_ORIGIN).sort()).toEqual([...CONTEXT_LAYER_KINDS].sort());
  });

  it('passes a real layer set', () => {
    expect(checkLayerProvenance([...CONTEXT_LAYER_KINDS])).toEqual([]);
  });

  it('catches a layer kind with no origin mapped', () => {
    // What would happen if someone added a layer and skipped the mapping. The
    // cast is the point: it simulates the type error being ignored.
    const violations = checkLayerProvenance(['ui-scratchpad' as never]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.refusal).toBe('no-origin');
  });
});

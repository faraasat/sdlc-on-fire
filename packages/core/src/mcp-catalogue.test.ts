import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_MAX_AGE_DAYS,
  formatRecommendations,
  MCP_CATALOGUE,
  recommendMcpServers,
  type CatalogueEntry,
} from './mcp-catalogue.js';

/**
 * P2-MCP-02 — suggesting servers without inventing them.
 *
 * The failure this is arranged against is not a bad suggestion. It is a
 * *fluent* one: a plausible repository URL for a server that does not exist,
 * phrased exactly like one for a server that does, which carries a user through
 * an install at a package name somebody else can register.
 */

const entry = (overrides: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  id: 'supabase',
  forTech: ['supabase'],
  capability: 'Read the real schema.',
  source: 'https://github.com/supabase-community/supabase-mcp',
  strength: 'first-party',
  checkedOn: '2026-08-01',
  ...overrides,
});

const stack = (...names: string[]) => names.map((tech) => ({ tech, packages: [] }));

describe('the catalogue itself', () => {
  it('gives every entry a resolvable source and a checked date', () => {
    // The rule this module exists for, asserted against the shipped data rather
    // than against a fixture. Adding an entry without both is adding the
    // fabrication being guarded against.
    for (const item of MCP_CATALOGUE) {
      expect(item.source).toMatch(/^https:\/\//);
      expect(item.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(item.capability.length).toBeGreaterThan(40);
    }
  });

  it('depends on no registry API', () => {
    // ADR-0024's risk register: the registry landscape is young and fragmented
    // with no canonical authority, so building against one is premature.
    for (const item of MCP_CATALOGUE) {
      expect(item.source).not.toContain('smithery.ai');
      expect(item.source).not.toContain('mcp.so');
      expect(item.source).not.toContain('glama.ai');
    }
  });
});

describe('recommendMcpServers', () => {
  const catalogue = [entry(), entry({ id: 'github', forTech: ['github'] })];

  it('suggests only what the project actually uses', () => {
    const result = recommendMcpServers(stack('supabase', 'zod'), '2026-08-14', [], catalogue);
    expect(result.recommendations.map((r) => r.id)).toEqual(['supabase']);
  });

  it('reports the technologies it had nothing for', () => {
    // "Nothing else exists" and "nobody has looked" are different claims, and
    // only one of them is true.
    const result = recommendMcpServers(stack('supabase', 'zod'), '2026-08-14', [], catalogue);
    expect(result.unmatched).toEqual(['zod']);
    expect(formatRecommendations(result)).toContain('nobody has added one');
  });

  it('never re-suggests a server the user declined', () => {
    // ADR-0058 wants a decline recorded and revisable. Re-suggesting it every
    // run converts a recorded decision into a prompt the user keeps answering.
    const result = recommendMcpServers(stack('supabase'), '2026-08-14', ['supabase'], catalogue);
    expect(result.recommendations).toEqual([]);
    expect(result.settled).toEqual(['supabase']);
  });

  it('does not re-suggest one already consented to either', () => {
    expect(
      recommendMcpServers(stack('github'), '2026-08-14', ['github'], catalogue).recommendations,
    ).toEqual([]);
  });

  it('still counts a settled server as matched, so it is not reported unmatched', () => {
    // Otherwise declining the only server for a technology makes that
    // technology reappear as "nobody has looked", which is now false.
    const result = recommendMcpServers(stack('supabase'), '2026-08-14', ['supabase'], catalogue);
    expect(result.unmatched).toEqual([]);
  });

  it('marks an entry nobody has re-checked in a long time', () => {
    const old = [entry({ checkedOn: '2020-01-01' })];
    const result = recommendMcpServers(stack('supabase'), '2026-08-14', [], old);
    expect(result.recommendations[0]?.stale).toBe(true);
    expect(formatRecommendations(result)).toContain('re-verify before installing');
  });

  it('does not mark a recently checked entry stale', () => {
    const result = recommendMcpServers(stack('supabase'), '2026-08-14', [], catalogue);
    expect(result.recommendations[0]?.stale).toBe(false);
    expect(CATALOGUE_MAX_AGE_DAYS).toBeGreaterThan(0);
  });

  it('matches case-insensitively without losing the technology', () => {
    const result = recommendMcpServers(stack('Supabase'), '2026-08-14', [], catalogue);
    expect(result.recommendations).toHaveLength(1);
    expect(result.unmatched).toEqual([]);
  });

  it('matches whichever side carries the odd casing', () => {
    // Both halves are lowercased before comparing. Lowercasing only the
    // project's side still passes a test whose catalogue entry is already
    // lowercase — which is every entry we ship, so the gap would be invisible.
    const result = recommendMcpServers(
      stack('supabase'),
      '2026-08-14',
      [],
      [entry({ forTech: ['Supabase'] })],
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.unmatched).toEqual([]);
  });

  it('matches on a package name and reports coverage against the technology', () => {
    // A catalogue entry keyed on `@supabase/supabase-js` must match a project
    // whose stack detector calls that technology `supabase` — and the
    // technology must then not also appear as uncovered.
    const result = recommendMcpServers(
      [{ tech: 'supabase', packages: ['@supabase/supabase-js'] }],
      '2026-08-14',
      [],
      [entry({ forTech: ['@supabase/supabase-js'] })],
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.unmatched).toEqual([]);
  });

  it('does not list a package name as an unmatched technology', () => {
    // Listing both halves reads as twice as much missing coverage as there is,
    // and a report that overstates its own gaps gets skimmed.
    const result = recommendMcpServers(
      [{ tech: 'zod', packages: ['zod'] }],
      '2026-08-14',
      [],
      catalogue,
    );
    expect(result.unmatched).toEqual(['zod']);
  });

  it('says a server has no read-only mode rather than omitting the line', () => {
    // Materially different advice: without one, every useful call needs a
    // person, and that is worth knowing before installing rather than after.
    const result = recommendMcpServers(
      stack('supabase'),
      '2026-08-14',
      [],
      [entry({ readOnlyMode: undefined })],
    );
    expect(formatRecommendations(result)).toContain('every call would need a person');
  });

  it('says nothing is installed by suggesting it', () => {
    const text = formatRecommendations(
      recommendMcpServers(stack('supabase'), '2026-08-14', [], catalogue),
    );
    expect(text).toContain('Nothing is installed or enabled until you run');
  });

  it('suggests nothing for a project with no matching stack', () => {
    expect(
      recommendMcpServers(stack('cobol'), '2026-08-14', [], catalogue).recommendations,
    ).toEqual([]);
  });
});

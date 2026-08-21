import { describe, expect, it } from 'vitest';
import { assessSources, formatSourceQuality, sourceTierOf } from './source-tier.js';

/** P3-RES-02 / ADR-0073 §6 — citations are not equal. */

describe('classifying one source', () => {
  it('reads a paper as primary', () => {
    expect(sourceTierOf('https://arxiv.org/html/2605.21384v1').tier).toBe('A');
    expect(sourceTierOf('https://dl.acm.org/doi/full/10.1145/3649835').tier).toBe('A');
  });

  it('reads a vendor’s own documentation as primary', () => {
    expect(sourceTierOf('https://docs.anthropic.com/llms.txt').tier).toBe('A');
    expect(sourceTierOf('https://example.com/docs/api').tier).toBe('A');
  });

  it('reads a registry as primary for a dependency claim', () => {
    expect(sourceTierOf('https://www.npmjs.com/package/drizzle-orm').tier).toBe('A');
  });

  it('reads an engineering blog as secondary', () => {
    expect(sourceTierOf('https://github.blog/some-post').tier).toBe('B');
    expect(sourceTierOf('https://martinfowler.com/articles/x.html').tier).toBe('B');
  });

  it('reads a listicle as unsubstantiated whatever the host', () => {
    // Matched on the path, because the same domain routinely carries both a
    // changelog and a ranking-bait post.
    expect(sourceTierOf('https://github.blog/top-10-tools-in-2026').tier).toBe('C');
    expect(sourceTierOf('https://example.com/best-orm-alternatives').tier).toBe('C');
  });

  it('defaults an unrecognised host to C, not B', () => {
    // The cautious direction on purpose: "I have never heard of this" is not
    // evidence that it is reputable, and treating it as B is the exact
    // substitution the tier exists to prevent.
    const source = sourceTierOf('https://some-agency-blog.example/report');
    expect(source.tier).toBe('C');
    expect(source.why).toContain('unrecognised host');
  });

  it('lets an author override the inference', () => {
    // A rule a person who is right cannot override is a rule people route around.
    const source = sourceTierOf('[B] https://some-agency-blog.example/report');
    expect(source.tier).toBe('B');
    expect(source.url).toBe('https://some-agency-blog.example/report');
    expect(source.why).toContain('declared');
  });

  it('marks a non-URL citation as unverifiable rather than trusted', () => {
    // ADR-0073 allows citing a paywalled paper by title — and it cannot be
    // checked, so it does not count as substantiation either.
    const source = sourceTierOf('Zhao et al., SpecBench, 2026');
    expect(source.malformed).toBe(true);
    expect(source.tier).toBe('C');
    expect(source.why).toContain('recalled-not-fetched');
  });
});

describe('judging the set, not each citation', () => {
  it('accepts one marketing page beside a paper', () => {
    // Normal and fine. The rule is about what the doc *rests on*.
    const quality = assessSources([
      'https://arxiv.org/abs/1234.5678',
      'https://example.com/best-tools-in-2026',
    ]);
    expect(quality.substantiated).toBe(true);
    expect(quality.findings).toEqual([]);
  });

  it('refuses a doc resting entirely on tier C', () => {
    const quality = assessSources([
      'https://a-agency.example/ultimate-guide',
      'https://b-agency.example/top-10',
    ]);
    expect(quality.substantiated).toBe(false);
    expect(quality.findings[0]).toContain('never as a figure');
  });

  it('refuses a doc with no sources at all', () => {
    expect(assessSources([]).findings[0]).toContain('is not one');
  });

  it('counts each tier', () => {
    const quality = assessSources([
      'https://arxiv.org/abs/1',
      'https://web.dev/x',
      'https://x.example/top-5',
    ]);
    expect(quality.counts).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('names every unresolvable citation, not just the first', () => {
    const quality = assessSources(['Zhao et al. 2026', 'Qwen Team 2026']);
    expect(quality.findings.filter((f) => f.includes('not a resolvable URL'))).toHaveLength(2);
  });

  it('prints the tier beside each source', () => {
    expect(formatSourceQuality(assessSources(['https://arxiv.org/abs/1']))).toContain('[A]');
  });
});

describe('a project’s own site is its primary record', () => {
  it('reads zod.dev as primary for zod', () => {
    // The rule a hostname allowlist cannot express, and the one that matters
    // most: no fixed list will ever contain the library somebody adds tomorrow.
    expect(sourceTierOf('https://zod.dev/', 'zod').tier).toBe('A');
  });

  it('does not read it as primary for an unrelated technology', () => {
    // Otherwise "the vendor's own site" degrades into "any site", which is the
    // permissive failure the whole tier exists to avoid.
    expect(sourceTierOf('https://zod.dev/', 'drizzle-orm').tier).toBe('C');
  });

  it('reduces a scoped package name to the part that names the project', () => {
    // `@electric-sql/pglite` is documented at electric-sql.com, not at
    // `@electric-sql`.
    expect(sourceTierOf('https://electric-sql.com/docs', '@electric-sql/pglite').tier).toBe('A');
  });

  it('ignores a technology name too short to be distinctive', () => {
    // A two-character name would match almost any host, which is worse than no
    // rule at all.
    expect(sourceTierOf('https://random-blog.example/post', 'ky').tier).toBe('C');
  });

  it('still refuses a listicle on the project’s own domain', () => {
    // Ranking bait does not become primary by being self-published.
    expect(sourceTierOf('https://zod.dev/blog/top-10-validators', 'zod').tier).toBe('C');
  });
});

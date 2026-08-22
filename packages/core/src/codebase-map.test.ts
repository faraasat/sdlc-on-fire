import { describe, expect, it } from 'vitest';
import {
  domainOf,
  inferredSpecStub,
  isIgnored,
  isTest,
  mapCodebase,
  slugify,
} from './codebase-map.js';

/**
 * P4-BROWN-02 — codebase mapping.
 *
 * The property under test above all others: an inferred spec must never pass as
 * an authored one. A generated tree of forty confident-looking specs is worse
 * than no tree — it looks like the work was done, nobody re-reads it, and every
 * gate downstream checks against a description nobody agreed to.
 */

const f = (path: string, size = 100): { path: string; size: number } => ({ path, size });

describe('domainOf', () => {
  it('takes the segment under a source root, not the root', () => {
    // A mapper that proposed `src` would produce one giant bucket and call it a
    // specification.
    expect(domainOf('src/billing/invoice.ts')).toBe('billing');
    expect(domainOf('lib/auth/token.ts')).toBe('auth');
  });

  it('walks past nested source roots in a monorepo', () => {
    expect(domainOf('packages/core/src/billing/invoice.ts')).toBe('billing');
  });

  it('returns null for a file at the repository root', () => {
    expect(domainOf('index.ts')).toBeNull();
  });

  it('returns null when the candidate is the file itself', () => {
    expect(domainOf('src/index.ts')).toBeNull();
  });
});

describe('isIgnored', () => {
  it('skips toolchain directories at any depth', () => {
    expect(isIgnored('node_modules/x/index.js')).toBe(true);
    expect(isIgnored('packages/core/dist/index.js')).toBe(true);
    expect(isIgnored('src/billing/invoice.ts')).toBe(false);
  });
});

describe('isTest', () => {
  it('recognises both conventions', () => {
    expect(isTest('src/billing/invoice.test.ts')).toBe(true);
    expect(isTest('tests/billing/invoice.ts')).toBe(true);
    expect(isTest('src/billing/invoice.ts')).toBe(false);
  });
});

describe('mapCodebase', () => {
  it('proposes a domain from a directory with enough source files', () => {
    const map = mapCodebase([f('src/billing/a.ts'), f('src/billing/b.ts')]);
    expect(map.domains.map((d) => d.slug)).toEqual(['billing']);
  });

  it('ignores a directory with a single file', () => {
    // A single file is a utility. A domain per helper produces a spec tree with
    // more entries than the codebase has ideas, which is unreadable and
    // therefore unread.
    expect(mapCodebase([f('src/util/once.ts')]).domains).toEqual([]);
  });

  it('ranks a domain with tests above one without', () => {
    // Tests are the strongest evidence something is a real domain, and the
    // output is a list somebody reads top-down and stops partway.
    const map = mapCodebase([
      f('src/reporting/a.ts'),
      f('src/reporting/b.ts'),
      f('src/reporting/c.ts'),
      f('src/billing/a.ts'),
      f('src/billing/b.ts'),
      f('src/billing/a.test.ts'),
    ]);
    expect(map.domains[0]?.slug).toBe('billing');
  });

  it('counts tests separately from sources', () => {
    const map = mapCodebase([
      f('src/billing/a.ts'),
      f('src/billing/b.ts'),
      f('src/billing/a.test.ts'),
    ]);
    expect(map.domains[0]?.fileCount).toBe(2);
    expect(map.domains[0]?.testCount).toBe(1);
  });

  it('does not count a test file toward the minimum', () => {
    // Otherwise one source file plus its test proposes a domain, and the
    // minimum stops meaning anything.
    expect(mapCodebase([f('src/util/once.ts'), f('src/util/once.test.ts')]).domains).toEqual([]);
  });

  it('skips toolchain directories and says which', () => {
    const map = mapCodebase([f('node_modules/pkg/a.ts'), f('node_modules/pkg/b.ts')]);
    expect(map.domains).toEqual([]);
    expect(map.skipped[0]?.path).toBe('node_modules');
  });

  it('ignores non-source files entirely', () => {
    expect(mapCodebase([f('src/billing/a.json'), f('src/billing/b.yaml')]).domains).toEqual([]);
  });

  it('caps the number of domains and says how many it dropped', () => {
    const files = Array.from({ length: 60 }, (_, i) => [
      f(`src/d${String(i)}/a.ts`),
      f(`src/d${String(i)}/b.ts`),
    ]).flat();
    const map = mapCodebase(files, { maxDomains: 5 });
    expect(map.domains).toHaveLength(5);
    expect(map.skipped.some((s) => s.because.includes('capped'))).toBe(true);
  });

  it('marks every domain as inferred', () => {
    // The field exists so that its *absence* means a human wrote the file.
    const map = mapCodebase([f('src/billing/a.ts'), f('src/billing/b.ts')]);
    expect(map.domains.every((d) => d.inferred)).toBe(true);
  });

  it('gives a reason a person can disagree with', () => {
    const map = mapCodebase([f('src/billing/a.ts'), f('src/billing/b.ts')]);
    expect(map.domains[0]?.because).toContain('2 source file(s)');
    expect(map.domains[0]?.because).toContain('no tests found');
  });

  it('is stable for reordered input', () => {
    const files = [f('src/b/x.ts'), f('src/b/y.ts'), f('src/a/x.ts'), f('src/a/y.ts')];
    const forward = mapCodebase(files).domains.map((d) => d.slug);
    const reversed = mapCodebase([...files].reverse()).domains.map((d) => d.slug);
    expect(reversed).toEqual(forward);
  });

  it('returns an empty map for an empty repository', () => {
    expect(mapCodebase([])).toEqual({ domains: [], filesScanned: 0, skipped: [] });
  });
});

describe('inferredSpecStub', () => {
  const domain = {
    slug: 'billing',
    from: 'billing',
    fileCount: 3,
    testCount: 1,
    because: '3 source file(s) and 1 test(s) under billing/',
    confidence: 'likely' as const,
    inferred: true as const,
  };

  it('carries the inferred marker in frontmatter', () => {
    expect(inferredSpecStub(domain)).toContain('inferred: true');
  });

  it('contains no requirement, because inventing one would be signing it', () => {
    // Writing a plausible `The system MUST …` here would make the product
    // author a specification and then check gates against it.
    const stub = inferredSpecStub(domain);
    expect(stub).not.toMatch(/The system MUST \w/);
    expect(stub).toContain('(unwritten)');
  });

  it('says plainly that nothing here was agreed', () => {
    expect(inferredSpecStub(domain)).toContain('Inferred, not specified');
  });

  it('tells the author how to turn it into a specification', () => {
    expect(inferredSpecStub(domain)).toContain('delete the `inferred: true` marker');
  });

  it('records the evidence it was proposed from', () => {
    expect(inferredSpecStub(domain)).toContain('3 source file(s)');
  });
});

/**
 * P5-PILOT-01 — separating product surface from tooling and grab bags.
 *
 * From the hono pilot: 4 of 12 proposed domains were noise — `benchmarks`,
 * `perf-measures` and `runtime-tests` are about the product rather than part of
 * it, and `utils` is a pile of helpers with no single obligation. A reader given
 * twelve domains of which four are wrong trusts the other eight less.
 */
describe('product surface vs tooling', () => {
  it('excludes a benchmark directory entirely, and says why', () => {
    // Not a badly-named domain — not a domain. Excluded rather than ranked low.
    const map = mapCodebase([f('benchmarks/a.ts'), f('benchmarks/b.ts')]);
    expect(map.domains).toEqual([]);
    expect(
      map.skipped.some((s) => s.because.includes('about the product rather than part of it')),
    ).toBe(true);
  });

  it('excludes every tooling directory the pilot surfaced', () => {
    for (const dir of [
      'benchmarks',
      'perf-measures',
      'runtime-tests',
      'examples',
      'e2e',
      'scripts',
    ]) {
      const map = mapCodebase([f(`${dir}/a.ts`), f(`${dir}/b.ts`)]);
      expect(map.domains, dir).toEqual([]);
    }
  });

  it('proposes a grab-bag name but marks it unlikely', () => {
    // Reported, never silently dropped: a real domain that happens to be badly
    // named must still be visible.
    const map = mapCodebase([f('src/utils/a.ts'), f('src/utils/b.ts')]);
    expect(map.domains).toHaveLength(1);
    expect(map.domains[0]?.confidence).toBe('unlikely');
    expect(map.domains[0]?.because).toContain('pile of helpers');
  });

  it('does not mark an ambiguous-but-real directory unlikely', () => {
    // `helper/` on hono is genuine product surface and `utils/` is a grab bag,
    // and they are the same shape on disk. The list is names, not a heuristic.
    const map = mapCodebase([f('src/helper/a.ts'), f('src/helper/b.ts')]);
    expect(map.domains[0]?.confidence).toBe('likely');
  });

  it('ranks every likely domain above every unlikely one', () => {
    // A reader who stops halfway should have seen everything the mapper
    // actually believes in.
    const map = mapCodebase([
      f('src/utils/a.ts'),
      f('src/utils/b.ts'),
      f('src/utils/c.ts'),
      f('src/utils/d.ts'),
      f('src/router/a.ts'),
      f('src/router/b.ts'),
    ]);
    expect(map.domains.map((d) => d.slug)).toEqual(['router', 'utils']);
  });
});

describe('slugify', () => {
  it('makes a filename-safe slug and never returns empty', () => {
    expect(slugify('Billing & Invoicing')).toBe('billing-invoicing');
    expect(slugify('***')).toBe('untitled');
  });
});

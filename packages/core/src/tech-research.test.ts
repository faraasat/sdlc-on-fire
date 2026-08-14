import { describe, expect, it } from 'vitest';
import {
  detectStack,
  evaluateTechResearch,
  refreshByFor,
  staleRegistryEntries,
  techNameFor,
  TECH_RESEARCH_FILES,
  type TechDocRecord,
} from './index.js';

/**
 * P2-RES-01 — the checker, not the research.
 *
 * The research is a web-enabled reading task no function performs. What is
 * testable, and what these cases are about, is every way a folder ends up
 * looking researched while containing nothing: it is missing files, it has no
 * dates so it can never expire, it cites nothing, it is still the template, or
 * it was genuinely researched against a version that no longer exists.
 */

const doc = (overrides: Partial<TechDocRecord> = {}): TechDocRecord => ({
  file: 'docs.md',
  researchedOn: '2026-06-01',
  refreshBy: '2026-09-01',
  sources: ['https://nextjs.org/docs'],
  bodyChars: 4_000,
  templateMarkers: [],
  ...overrides,
});

const complete = (overrides: Partial<TechDocRecord> = {}): TechDocRecord[] =>
  TECH_RESEARCH_FILES.map((file) => doc({ file, ...overrides }));

describe('evaluateTechResearch', () => {
  it('passes a folder that is complete, dated, sourced and unexpired', () => {
    const verdict = evaluateTechResearch('next', complete(), '2026-08-14');
    expect(verdict.status).toBe('current');
    expect(verdict.usable).toBe(true);
  });

  it('reports a missing folder as missing, not as an error', () => {
    const verdict = evaluateTechResearch('next', [], '2026-08-14');
    expect(verdict.status).toBe('missing');
    expect(verdict.usable).toBe(false);
  });

  it('names the files a partial folder is short of', () => {
    const verdict = evaluateTechResearch('next', [doc()], '2026-08-14');
    expect(verdict.status).toBe('incomplete');
    expect(verdict.detail.join(' ')).toContain('api-contract.md is missing');
  });

  it('refuses an undated folder, which could otherwise never go stale', () => {
    // The loophole worth closing explicitly: with no `refresh-by` there is no
    // clock, so the folder is permanently current and the refresh rule never
    // applies to it.
    const docs = complete();
    docs[0] = doc({ file: 'docs.md', refreshBy: undefined });
    expect(evaluateTechResearch('next', docs, '2026-08-14').status).toBe('undated');
  });

  it('refuses a folder that cites nothing', () => {
    expect(evaluateTechResearch('next', complete({ sources: [] }), '2026-08-14').status).toBe(
      'unsourced',
    );
  });

  it('refuses a folder that is still the template', () => {
    const docs = complete();
    docs[1] = doc({ file: 'optimizations.md', templateMarkers: ['TODO'] });
    const verdict = evaluateTechResearch('next', docs, '2026-08-14');
    expect(verdict.status).toBe('template');
    expect(verdict.detail.join(' ')).toContain('template text');
  });

  it('refuses a sourced folder with no prose in it', () => {
    // Frontmatter alone satisfies every other check. A file with a `sources:`
    // list and nothing under it is a citation with no claim attached.
    expect(evaluateTechResearch('next', complete({ bodyChars: 40 }), '2026-08-14').status).toBe(
      'template',
    );
  });

  it('treats an expired folder as no research at all (ADR-0045)', () => {
    const verdict = evaluateTechResearch('next', complete(), '2026-09-02');
    expect(verdict.status).toBe('stale');
    expect(verdict.usable).toBe(false);
    expect(verdict.detail.join(' ')).toContain('re-research before reuse');
  });

  it('is still current on the refresh-by date itself', () => {
    // Inclusive of the day. Expiring *on* the date makes "refresh by the 1st"
    // mean the 31st, which is not what anyone writing the date meant.
    expect(evaluateTechResearch('next', complete(), '2026-09-01').status).toBe('current');
  });

  it('reports the first reason, not all of them', () => {
    // Telling someone their refresh-by is stale when the file does not exist is
    // noise that buries the thing they can act on.
    const verdict = evaluateTechResearch(
      'next',
      [doc({ sources: [], refreshBy: undefined })],
      '2027-01-01',
    );
    expect(verdict.status).toBe('incomplete');
  });

  it('says how long is left on a current folder', () => {
    expect(evaluateTechResearch('next', complete(), '2026-08-14').detail.join(' ')).toContain(
      '18 day(s)',
    );
  });
});

describe('refreshByFor', () => {
  it('defaults to 90 days, per the template', () => {
    expect(refreshByFor('2026-08-14')).toBe('2026-11-12');
  });

  it('gives a churning framework a shorter clock than a spec', () => {
    expect(refreshByFor('2026-08-14', 'churning') < refreshByFor('2026-08-14', 'spec')).toBe(true);
  });

  it('refuses a date it cannot parse rather than inventing one', () => {
    expect(() => refreshByFor('last Tuesday')).toThrow(/not an ISO date/);
  });
});

describe('techNameFor', () => {
  it('maps a scoped package to its vendor', () => {
    // The first version took the other half and produced folders called `cli`
    // and `js` — names identifying nothing, colliding with every other vendor's
    // `cli`. Found by running it against this repository's own manifest.
    expect(techNameFor('@changesets/cli')).toBe('changesets');
    expect(techNameFor('@supabase/supabase-js')).toBe('supabase');
  });

  it('leaves an unscoped package alone', () => {
    expect(techNameFor('drizzle-orm')).toBe('drizzle-orm');
  });
});

describe('detectStack', () => {
  const manifest = {
    dependencies: { next: '^15.0.0', zod: '^4.0.0' },
    devDependencies: {
      typescript: '^5.0.0',
      '@types/node': '^22.0.0',
      'eslint-plugin-x': '^1.0.0',
    },
  };

  it('reports every dependency, not only the ones it recognises', () => {
    // A detector that only reports known packages quietly exempts every
    // dependency nobody thought to list — and those are the least researched.
    expect(detectStack(manifest).map((tech) => tech.tech)).toEqual(['next', 'zod']);
  });

  it('drops lint and type plumbing by pattern, not by an ever-growing list', () => {
    const names = detectStack(manifest).flatMap((tech) => tech.packages.map((p) => p.name));
    expect(names).not.toContain('@types/node');
    expect(names).not.toContain('eslint-plugin-x');
  });

  it('attaches an official scaffold command where one is known', () => {
    const next = detectStack(manifest).find((tech) => tech.tech === 'next');
    expect(next?.scaffold?.command).toBe('npx create-next-app@latest');
    // Sourced and dated, or it is the training-data artifact this exists to stop.
    expect(next?.scaffold?.source).toMatch(/^https:\/\//);
    expect(next?.scaffold?.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves scaffold absent rather than guessing a command', () => {
    expect(detectStack(manifest).find((tech) => tech.tech === 'zod')?.scaffold).toBeUndefined();
  });

  it('groups a vendor’s packages into one technology and lists them', () => {
    const stack = detectStack({
      dependencies: { '@aws-sdk/client-s3': '^3', '@aws-sdk/client-sqs': '^3' },
    });
    expect(stack).toHaveLength(1);
    expect(stack[0]?.packages.map((p) => p.name)).toEqual([
      '@aws-sdk/client-s3',
      '@aws-sdk/client-sqs',
    ]);
  });

  it('survives a manifest that is not an object', () => {
    expect(detectStack(null)).toEqual([]);
    expect(detectStack('{}')).toEqual([]);
  });
});

describe('staleRegistryEntries', () => {
  it('holds the checker’s own research to the checker’s own rule', () => {
    // A freshness checker exempt from its own rule is a rule nobody believes.
    const registry = {
      old: { command: 'x', source: 'https://example.com', checkedOn: '2020-01-01' },
      fresh: { command: 'y', source: 'https://example.com', checkedOn: '2026-08-01' },
    };
    expect(staleRegistryEntries('2026-08-14', registry)).toEqual(['old']);
  });

  it('reports rather than dropping a stale entry', () => {
    // An old command is still better than none; silently removing it would
    // leave a project hand-scaffolding for want of a date.
    const registry = { old: { command: 'x', source: 's', checkedOn: '2020-01-01' } };
    expect(staleRegistryEntries('2026-08-14', registry)).toContain('old');
  });
});

import { describe, expect, it } from 'vitest';
import {
  VISIBILITY_CHECKS,
  checkCorpusVisibility,
  checkVisibility,
  readVisibilityDoc,
  type VisibilityDoc,
} from './doc-visibility.js';

/**
 * P4-DOC-01 — the doc-visibility dimension.
 *
 * The checks are the ones the 252,000-trial factorial study found to matter
 * (`techniques/41` §3), and the most important assertion in this file is the
 * one about what is *not* checked: that study looked for a formatting effect
 * and found none, so a formatting check here would be measuring a null result.
 */

const NOW = new Date('2026-08-22T00:00:00Z');

const doc = (over: Partial<VisibilityDoc> = {}): VisibilityDoc => ({
  path: 'docs/guide.md',
  title: 'How configuration is resolved',
  body: 'Resolution reads config.yaml first, then falls back after 30s.',
  updated: '2026-08-01',
  ...over,
});

const checks = (d: VisibilityDoc): string[] => checkVisibility(d, NOW).map((f) => f.check);

describe('checkVisibility', () => {
  it('finds nothing wrong with a specific, current, well-titled doc', () => {
    expect(checkVisibility(doc(), NOW)).toEqual([]);
  });

  describe('title-question', () => {
    it('flags a bare-noun title that matches no question', () => {
      // "Configuration" matches nothing anyone types; "How configuration is
      // resolved" does. Topic match was the strongest gatekeeper in the study.
      expect(checks(doc({ title: 'Configuration' }))).toContain('title-question');
    });

    it('flags a missing title', () => {
      expect(checks(doc({ title: null }))).toContain('title-question');
    });

    it('accepts a title long enough to carry a question', () => {
      expect(checks(doc({ title: 'How the daemon resolves identity' }))).not.toContain(
        'title-question',
      );
    });

    it('weights it as a gatekeeper', () => {
      const finding = checkVisibility(doc({ title: 'Setup' }), NOW)[0];
      expect(finding?.weight).toBe('gatekeeper');
    });
  });

  describe('stale-timestamp', () => {
    it('flags an absent date, and says it is absent', () => {
      // Undated is reported as well as old: nothing reading the page can tell
      // whether it is current, which is the same failure with less information.
      //
      // The detail is asserted, not just the check name. Both this and an
      // unparseable date emit `stale-timestamp`, so a version that fell through
      // to `Date.parse(undefined)` — NaN, "not a date" — passes a name-only
      // assertion while telling the author their missing date is malformed.
      const finding = checkVisibility(doc({ updated: undefined }), NOW).find(
        (f) => f.check === 'stale-timestamp',
      );
      expect(finding?.detail).toContain('no updated date');
    });

    it('flags a date that is not a date, and says it is not a date', () => {
      const finding = checkVisibility(doc({ updated: 'last tuesday' }), NOW).find(
        (f) => f.check === 'stale-timestamp',
      );
      expect(finding?.detail).toContain('not a date');
      expect(finding?.detail).toContain('last tuesday');
    });

    it('flags a date over a year old', () => {
      expect(checks(doc({ updated: '2024-01-01' }))).toContain('stale-timestamp');
    });

    it('accepts a recent date', () => {
      expect(checks(doc({ updated: '2026-06-01' }))).not.toContain('stale-timestamp');
    });

    it('takes `now` as a parameter rather than reading the clock', () => {
      // A check whose result depends on the wall clock cannot be tested at its
      // own boundary — this doc is fresh in 2026 and stale in 2028.
      const d = doc({ updated: '2026-06-01' });
      expect(checkVisibility(d, new Date('2028-01-01T00:00:00Z')).map((f) => f.check)).toContain(
        'stale-timestamp',
      );
    });
  });

  describe('hedged-prose', () => {
    it('flags a body thick with hedges', () => {
      expect(
        checks(doc({ body: 'This might generally speaking be somewhat relatively true, 1 time.' })),
      ).toContain('hedged-prose');
    });

    it('tolerates one or two hedges rather than policing every sentence', () => {
      expect(checks(doc({ body: 'This might be true. Version 2.1 ships Tuesday.' }))).not.toContain(
        'hedged-prose',
      );
    });
  });

  describe('no-specifics', () => {
    it('flags a body with no number, version, measurement or filename', () => {
      expect(
        checks(doc({ body: 'The system processes the input and returns a result.' })),
      ).toContain('no-specifics');
    });

    it('accepts a filename as a specific', () => {
      expect(checks(doc({ body: 'Reads from settings.json on boot.' }))).not.toContain(
        'no-specifics',
      );
    });

    it('accepts a measurement as a specific', () => {
      expect(checks(doc({ body: 'The retry budget is 250ms.' }))).not.toContain('no-specifics');
    });

    it('does not flag an empty body, which is a different problem', () => {
      expect(checks(doc({ body: '   ' }))).not.toContain('no-specifics');
    });
  });

  describe('keyword-gap', () => {
    it('flags a declared keyword the body never mentions', () => {
      expect(checks(doc({ keywords: ['rollback'] }))).toContain('keyword-gap');
    });

    it('matches case-insensitively', () => {
      expect(checks(doc({ keywords: ['CONFIG.YAML'] }))).not.toContain('keyword-gap');
    });

    it('says which keywords are missing rather than that some are', () => {
      const finding = checkVisibility(doc({ keywords: ['rollback', 'quorum'] }), NOW).find(
        (f) => f.check === 'keyword-gap',
      );
      expect(finding?.detail).toContain('rollback');
      expect(finding?.detail).toContain('quorum');
    });

    it('is silent when no keywords are declared', () => {
      expect(checks(doc({ keywords: undefined }))).not.toContain('keyword-gap');
    });
  });

  it('does not check formatting, because the experiment found no effect', () => {
    // The assertion that records a *null result* as a design decision. A doc
    // with no headings, no lists and no structure is not flagged, because the
    // 18-factor study looked for a formatting effect and did not find one.
    const unstructured = doc({
      body: 'no headings no lists no tables just prose about config.yaml and 30s timeouts',
    });
    expect(checkVisibility(unstructured, NOW)).toEqual([]);
    expect(VISIBILITY_CHECKS).not.toContain('formatting');
  });

  it('skips a stub, because an unwritten doc is not a hard-to-find doc', () => {
    // Found by running this on a fresh `init`: eleven one-line scaffolded stubs
    // produced 42 gatekeeper findings before the user wrote anything. Telling
    // someone to retitle and date an empty file is the wrong instruction, and a
    // check that is entirely noise on a new project is one people learn to skip.
    expect(
      checkVisibility(doc({ title: 'AUDIT', body: '# AUDIT', updated: undefined }), NOW),
    ).toEqual([]);
    expect(
      checkVisibility(doc({ title: 'X', body: '# X\n\n## Y\n', updated: undefined }), NOW),
    ).toEqual([]);
  });

  it('still checks a doc with any prose at all', () => {
    // The boundary is strict on purpose: one sentence is content, and content
    // that nobody can find is exactly what this dimension is for.
    const barely = doc({ title: 'AUDIT', body: '# AUDIT\n\nWe audit things.', updated: undefined });
    expect(checkVisibility(barely, NOW).length).toBeGreaterThan(0);
  });

  it('reports several findings at once rather than stopping at the first', () => {
    const bad = doc({
      title: 'Setup',
      updated: undefined,
      body: 'It depends. It may possibly usually work.',
    });
    expect(checkVisibility(bad, NOW).length).toBeGreaterThanOrEqual(4);
  });
});

describe('checkCorpusVisibility', () => {
  it('lists findings per document and never sums them', () => {
    // ADR-0074: a single number hides an upstream loss behind a downstream
    // gain, which is what SAGEO Arena measured.
    const report = checkCorpusVisibility([doc(), doc({ path: 'b.md', title: 'X' })], NOW);
    expect(report.docsScanned).toBe(2);
    expect(report.findings.every((f) => typeof f.path === 'string')).toBe(true);
    expect(report).not.toHaveProperty('score');
  });

  it('handles an empty corpus', () => {
    expect(checkCorpusVisibility([], NOW)).toEqual({ findings: [], docsScanned: 0 });
  });
});

describe('readVisibilityDoc', () => {
  it('takes the title from the first heading, not the filename', () => {
    // The filename is an identity; the heading is what a reader and a retriever
    // actually see.
    const d = readVisibilityDoc('docs/x.md', '# How retries are bounded\n\nbody');
    expect(d.title).toBe('How retries are bounded');
  });

  it('reads the updated date and keywords from frontmatter', () => {
    const d = readVisibilityDoc('x.md', '# T', { updated: '2026-01-01', keywords: ['a', 'b'] });
    expect(d.updated).toBe('2026-01-01');
    expect(d.keywords).toEqual(['a', 'b']);
  });

  it('accepts last_updated as an alias', () => {
    expect(readVisibilityDoc('x.md', '# T', { last_updated: '2026-01-01' }).updated).toBe(
      '2026-01-01',
    );
  });

  it('reports no title rather than guessing when there is no heading', () => {
    expect(readVisibilityDoc('x.md', 'just prose').title).toBeNull();
  });

  it('ignores non-string keywords rather than rendering undefined', () => {
    const d = readVisibilityDoc('x.md', '# T', { keywords: ['ok', 42, null] });
    expect(d.keywords).toEqual(['ok']);
  });
});

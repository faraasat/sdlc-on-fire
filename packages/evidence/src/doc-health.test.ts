import { describe, expect, it } from 'vitest';
import {
  MIN_SECTION_WORDS,
  checkDocHealth,
  decisionHome,
  isIndex,
  needsPromotion,
} from './doc-health.js';

/** P1-DOC-02 — corpus health (ADR-0053) and decision homes (ADR-0050). */

const long = (seed: string): string =>
  Array.from({ length: MIN_SECTION_WORDS + 10 }, (_, i) => `${seed}${String(i % 7)}`).join(' ');

describe('orphans and indexes', () => {
  it('flags a doc no index points at', () => {
    const report = checkDocHealth([
      { path: 'docs/README.md', links: ['docs/a.md'] },
      { path: 'docs/a.md', links: [] },
      { path: 'docs/b.md', links: [] },
    ]);
    // Retrievable and undiscovered: the agent that needed it never learned it
    // existed, and its author believes it is doing work.
    expect(report.findings.filter((f) => f.issue === 'orphan').map((f) => f.doc)).toEqual([
      'docs/b.md',
    ]);
  });

  it('never calls an index an orphan', () => {
    const report = checkDocHealth([{ path: 'docs/README.md', links: [] }]);
    // An index is reached by its folder, not by a link. Flagging every README
    // would drown the signal that matters.
    expect(report.findings.some((f) => f.issue === 'orphan')).toBe(false);
    expect(isIndex('docs/README.md')).toBe(true);
  });

  it('flags a folder with no index', () => {
    const report = checkDocHealth([
      { path: 'docs/README.md', links: ['docs/deep/a.md'] },
      { path: 'docs/deep/a.md', links: [] },
    ]);
    expect(report.findings.filter((f) => f.issue === 'missing-index').map((f) => f.doc)).toEqual([
      'docs/deep',
    ]);
  });
});

describe('redundancy', () => {
  it('flags two sections that say the same thing', () => {
    const body = long('word');
    const report = checkDocHealth([
      { path: 'docs/README.md', links: ['docs/a.md', 'docs/b.md'] },
      { path: 'docs/a.md', links: [], sections: [{ heading: 'Retries', body }] },
      { path: 'docs/b.md', links: [], sections: [{ heading: 'Retry policy', body }] },
    ]);
    // Two copies disagree eventually, and nothing says which one is wrong.
    expect(report.findings.some((f) => f.issue === 'redundant-section')).toBe(true);
  });

  it('ignores short sections that share vocabulary by chance', () => {
    const report = checkDocHealth([
      { path: 'docs/README.md', links: ['docs/a.md', 'docs/b.md'] },
      { path: 'docs/a.md', links: [], sections: [{ heading: 'A', body: 'the importer retries' }] },
      { path: 'docs/b.md', links: [], sections: [{ heading: 'B', body: 'the importer retries' }] },
    ]);
    expect(report.findings.some((f) => f.issue === 'redundant-section')).toBe(false);
  });

  it('does not compare a doc against itself', () => {
    const body = long('word');
    const report = checkDocHealth([
      { path: 'docs/README.md', links: ['docs/a.md'] },
      {
        path: 'docs/a.md',
        links: [],
        sections: [
          { heading: 'One', body },
          { heading: 'Two', body },
        ],
      },
    ]);
    expect(report.findings.some((f) => f.issue === 'redundant-section')).toBe(false);
  });

  it('never fails the check', () => {
    const body = long('word');
    const report = checkDocHealth([
      { path: 'docs/a.md', links: [], sections: [{ heading: 'A', body }] },
      { path: 'docs/b.md', links: [], sections: [{ heading: 'B', body }] },
    ]);
    // Lexical detection cannot tell a real duplicate from two docs quoting the
    // same contract, and a check that failed builds on that guess would be
    // switched off within a week.
    expect(report.ok).toBe(true);
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

describe('decision homes (ADR-0050)', () => {
  it('asks about scope, not importance', () => {
    expect(decisionHome({ constrainsOtherInitiatives: true })).toBe('global');
    // A decision that feels significant but binds one epic is local. Putting it
    // globally makes the global index a list of everything anyone decided,
    // which is how an index stops being read.
    expect(decisionHome({ constrainsOtherInitiatives: false })).toBe('initiative');
  });

  it('promotes a local decision whose scope grew', () => {
    expect(needsPromotion({ home: 'initiative', constrainsOtherInitiatives: true })).toBe(true);
    expect(needsPromotion({ home: 'global', constrainsOtherInitiatives: true })).toBe(false);
    expect(needsPromotion({ home: 'initiative', constrainsOtherInitiatives: false })).toBe(false);
  });
});

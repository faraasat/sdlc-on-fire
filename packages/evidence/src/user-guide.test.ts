import { describe, expect, it } from 'vitest';
import { MAX_SENTENCE_WORDS, WCAG_PALETTE, checkDiagram, checkReadability } from './user-guide.js';

/**
 * P1-DOC-03 — the user guide (ADR-0057).
 *
 * The failure this defends against is not someone writing a bad guide. It is
 * the person who just wrote the implementation writing the guide in the
 * vocabulary they have been using all day, where it reads fine to them.
 */

describe('readability', () => {
  it('accepts plain prose', () => {
    const report = checkReadability('You can import a spreadsheet. The tool checks each row.');
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('fails on product jargon', () => {
    const report = checkReadability('The context pack is assembled before each run.');
    // Decidable: the word is in the list or it is not.
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.kind).toBe('jargon');
  });

  it('only advises on a long sentence', () => {
    const long = `You can ${'really '.repeat(MAX_SENTENCE_WORDS)} import a spreadsheet.`;
    const report = checkReadability(long);
    expect(report.findings.some((f) => f.kind === 'long-sentence')).toBe(true);
    // A long sentence is sometimes the right sentence, and a score that failed
    // builds would be met by splitting clauses until the number moved.
    expect(report.ok).toBe(true);
  });

  it('reports reading ease without gating on it', () => {
    const report = checkReadability('You can import a spreadsheet. The tool checks each row.');
    expect(report.readingEase).toBeGreaterThan(50);
    expect(report.sentences).toBe(2);
  });

  it('ignores code blocks, where jargon is the point', () => {
    const report = checkReadability(
      'Run this:\n\n```\nsdlc verify --context pack\n```\n\nThen look.',
    );
    expect(report.ok).toBe(true);
  });
});

describe('diagrams', () => {
  const good = [
    'flowchart LR',
    '  accTitle: How a change reaches your users',
    '  accDescr: Three steps, left to right.',
    '  A[You ask] --> B[We build] --> C[You check]',
    '  classDef step fill:#1B4965,stroke:#0B2A3D,stroke-width:2px',
  ].join('\n');

  it('accepts a compliant user-facing diagram', () => {
    expect(checkDiagram(good, 'user')).toEqual([]);
  });

  it('refuses the deprecated init directive for either audience', () => {
    const source = `%%{init: {'theme':'dark'}}%%\n${good}`;
    // Deprecated since mermaid v10.5. A guide whose diagram silently stops
    // rendering is worse than one with no diagram.
    expect(checkDiagram(source, 'user').some((f) => f.rule === 'no-init-directive')).toBe(true);
    expect(checkDiagram(source, 'agent').some((f) => f.rule === 'no-init-directive')).toBe(true);
  });

  it('requires accessibility hooks on user-facing diagrams only', () => {
    const bare = 'flowchart LR\n  A --> B\n  classDef step fill:#1B4965,stroke-width:2px';
    expect(checkDiagram(bare, 'user').map((f) => f.rule)).toEqual(
      expect.arrayContaining(['acc-title', 'acc-descr']),
    );
    // Requiring an accDescr on every internal sequence diagram would produce a
    // hundred perfunctory ones, which helps nobody.
    expect(checkDiagram(bare, 'agent')).toEqual([]);
  });

  it('requires colour on a user-facing diagram', () => {
    const plain = 'flowchart LR\n  accTitle: x\n  accDescr: y\n  A --> B';
    expect(checkDiagram(plain, 'user').some((f) => f.rule === 'colour')).toBe(true);
  });

  it('refuses colour as the only signal (WCAG 1.4.1)', () => {
    const fillOnly = [
      'flowchart LR',
      '  accTitle: x',
      '  accDescr: y',
      '  A --> B',
      '  classDef step fill:#1B4965',
    ].join('\n');
    // A reader who cannot distinguish the fills must still be able to read it.
    expect(checkDiagram(fillOnly, 'user').some((f) => f.rule === 'colour-not-alone')).toBe(true);
  });

  it('ships a palette of its own rather than a theme name', () => {
    // Not all built-in mermaid themes pass WCAG AA, and a theme that changes
    // between releases would change every guide's contrast with no edit.
    expect(WCAG_PALETTE.length).toBeGreaterThan(0);
    for (const entry of WCAG_PALETTE) {
      expect(entry.fill).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(entry.stroke).not.toBe(entry.fill);
    }
  });
});

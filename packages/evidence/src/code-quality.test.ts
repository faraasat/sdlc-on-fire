import { describe, expect, it } from 'vitest';
import { analyseFile, OVERSIZED_COMMENT_LINES, summariseQuality } from './code-quality.js';

/**
 * Doc-comment presence and comment bloat (P1-GATE-11, ADR-0055/0056).
 *
 * The two checks have deliberately different standing, and most of what is
 * asserted here is that difference: presence gates because it is deterministic,
 * bloat advises because no reliable signal for it exists.
 */

describe('doc-comment presence', () => {
  it('accepts an exported symbol with a doc-comment above it', () => {
    const report = analyseFile('a.ts', '/** Does a thing. */\nexport function doThing() {}\n');
    expect(report.exported).toBe(1);
    expect(report.documented).toBe(1);
    expect(report.gating).toEqual([]);
  });

  it('flags an exported symbol with none, naming it and its line', () => {
    const report = analyseFile('a.ts', 'const x = 1;\nexport function doThing() {}\n');
    expect(report.gating[0]).toMatchObject({ symbol: 'doThing', line: 2 });
  });

  it('does not count a comment two statements up as documentation', () => {
    // A comment separated by other code documents something else.
    const report = analyseFile('a.ts', '/** About x. */\nconst x = 1;\nexport function y() {}\n');
    expect(report.gating).toHaveLength(1);
  });

  it('sees every exported form, not just functions', () => {
    const source = [
      'export function a() {}',
      'export class B {}',
      'export const c = 1;',
      'export interface D {}',
      'export type E = string;',
    ].join('\n');
    expect(analyseFile('a.ts', source).exported).toBe(5);
  });
});

describe('comment bloat is advisory, never gating', () => {
  it('flags a block long enough that its rationale belongs in an ADR', () => {
    const source = [
      '/**',
      ...(Array(OVERSIZED_COMMENT_LINES + 2).fill(' * words') as string[]),
      ' */',
      'const x = 1;',
    ].join('\n');
    const report = analyseFile('a.ts', source);
    expect(report.advisory[0]?.kind).toBe('oversized-comment-block');
    expect(report.advisory[0]?.detail).toMatch(/belongs in the ADR/);
  });

  it('leaves a normal doc-comment alone', () => {
    const report = analyseFile('a.ts', '/**\n * Short and useful.\n */\nexport const x = 1;\n');
    expect(report.advisory).toEqual([]);
  });

  it('never affects whether the gate passes', () => {
    // A heuristic that could fail a build would make people delete comments to
    // appease it — the opposite of what ADR-0056 wants.
    const bloated = [
      '/**',
      ...(Array(OVERSIZED_COMMENT_LINES + 2).fill(' * words') as string[]),
      ' */',
      '/** ok */',
      'export const x = 1;',
    ].join('\n');
    const summary = summariseQuality([analyseFile('a.ts', bloated)]);
    expect(summary.advisory.length).toBeGreaterThan(0);
    expect(summary.ok).toBe(true);
  });
});

describe('the summary', () => {
  it('fails only on missing doc-comments', () => {
    const summary = summariseQuality([analyseFile('a.ts', 'export function bare() {}\n')]);
    expect(summary.ok).toBe(false);
    expect(summary.undocumented).toHaveLength(1);
  });

  it('reports a comment ratio as context rather than a threshold', () => {
    const report = analyseFile('a.ts', '// one\n// two\nconst x = 1;\nconst y = 2;\n');
    expect(report.commentRatio).toBeGreaterThan(0);
    expect(report.commentRatio).toBeLessThan(1);
  });
});

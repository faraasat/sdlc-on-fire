import { describe, expect, it } from 'vitest';
import {
  evaluateKnowledgeMix,
  formatKnowledgeMix,
  knowledgeOf,
  type KnowledgeDeclaration,
} from './test-knowledge.js';

/** P3-QA-08 — how much the test knew, which the scope tier cannot say. */

const decl = (knowledge: 'white' | 'grey' | 'black', declared = true): KnowledgeDeclaration => ({
  file: `${knowledge}.test.ts`,
  knowledge,
  declared,
});

describe('reading the marker', () => {
  it('reads a declared black-box file', () => {
    const found = knowledgeOf('a.test.ts', '/** @knowledge black-box */\nimport …');
    expect(found.knowledge).toBe('black');
    expect(found.declared).toBe(true);
  });

  it('accepts both spellings of grey', () => {
    expect(knowledgeOf('a', '// @knowledge gray').knowledge).toBe('grey');
    expect(knowledgeOf('a', '// @knowledge grey').knowledge).toBe('grey');
  });

  it('accepts it with or without the "box" suffix', () => {
    expect(knowledgeOf('a', '// @knowledge black').knowledge).toBe('black');
    expect(knowledgeOf('a', '// @knowledge black box').knowledge).toBe('black');
  });

  it('defaults an undeclared file to white, and says it was not declared', () => {
    // The cautious direction. Assuming otherwise would let a black-box
    // requirement be satisfied by writing nothing down.
    const found = knowledgeOf('a.test.ts', 'import { it } from "vitest";');
    expect(found.knowledge).toBe('white');
    expect(found.declared).toBe(false);
  });

  it('does not scan the whole file for the marker', () => {
    // It belongs in the header. A marker buried on line 900 is not a
    // declaration anybody reading the file would see.
    const buried = `${Array.from({ length: 200 }, () => 'const x = 1;').join('\n')}\n// @knowledge black`;
    expect(knowledgeOf('a', buried).declared).toBe(false);
  });

  it('ignores the marker inside a string literal', () => {
    // Not hypothetical: the first version classified this module's own test
    // file as black box, because a fixture below contains the marker in a
    // string. Any file that documents the marker mentions it.
    const mentions = `const example = '// @knowledge black';`;
    expect(knowledgeOf('a', mentions).declared).toBe(false);
  });
});

describe('the mix against a policy', () => {
  it('passes by default, because nobody opted in', () => {
    // A requirement nobody asked for would make every existing project red on
    // upgrade, and a check people turn off is worse than one they turn on.
    expect(evaluateKnowledgeMix([decl('white'), decl('white')]).ok).toBe(true);
  });

  it('fails a suite below the required black-box share', () => {
    const mix = evaluateKnowledgeMix([decl('white'), decl('white'), decl('black')], {
      minBlackBox: 0.5,
      requireDeclaration: false,
    });
    expect(mix.ok).toBe(false);
    expect(mix.findings[0]).toContain('agrees with the implementation');
  });

  it('passes one at or above it', () => {
    expect(
      evaluateKnowledgeMix([decl('black'), decl('white')], {
        minBlackBox: 0.5,
        requireDeclaration: false,
      }).ok,
    ).toBe(true);
  });

  it('reports the share as null for an empty suite, not zero', () => {
    // "No black-box tests" and "no tests" are different states, and only one is
    // about this axis.
    expect(evaluateKnowledgeMix([]).blackBoxShare).toBeNull();
  });

  it('says so when a policy asks for coverage of an empty suite', () => {
    const mix = evaluateKnowledgeMix([], { minBlackBox: 0.3, requireDeclaration: false });
    expect(mix.ok).toBe(false);
    expect(mix.findings[0]).toContain('no test files at all');
  });

  it('can require the declaration itself', () => {
    const mix = evaluateKnowledgeMix([decl('white', false)], {
      minBlackBox: 0,
      requireDeclaration: true,
    });
    expect(mix.ok).toBe(false);
    expect(mix.findings[0]).toContain('nothing in the file can recover it');
  });

  it('counts each level', () => {
    const mix = evaluateKnowledgeMix([decl('black'), decl('grey'), decl('white'), decl('black')]);
    expect(mix.counts).toEqual({ black: 2, grey: 1, white: 1 });
  });
});

describe('what it says when there is no black box at all', () => {
  it('names the consequence rather than the count', () => {
    const text = formatKnowledgeMix(evaluateKnowledgeMix([decl('white'), decl('grey')]));
    expect(text).toContain('disagree with the code by accident');
  });

  it('says nothing of the sort for an empty suite', () => {
    // There is no finding here; the tier taxonomy is what reports a missing
    // suite, and duplicating it would produce two complaints about one thing.
    expect(formatKnowledgeMix(evaluateKnowledgeMix([]))).not.toContain('by accident');
  });
});

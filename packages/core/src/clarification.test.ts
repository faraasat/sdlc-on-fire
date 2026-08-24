import { describe, expect, it } from 'vitest';
import { clarificationGate, findClarifications } from './clarification.js';

describe('[NEEDS CLARIFICATION] in our own artifacts (P6-SURFACE-05)', () => {
  it('finds a marker and the question after it', () => {
    const found = findClarifications('Rows export as CSV.\n[NEEDS CLARIFICATION: which timezone?]');
    expect(found).toHaveLength(1);
    expect(found[0]?.question).toBe('which timezone?');
    expect(found[0]?.line).toBe(2);
  });

  it('reports line numbers, not offsets', () => {
    // An offset is correct and useless: a person reading "unresolved at
    // character 4,182" goes and counts.
    const found = findClarifications(['a', 'b', 'c', '[NEEDS CLARIFICATION: x]'].join('\n'));
    expect(found[0]?.line).toBe(4);
  });

  it('finds every marker on a line, and on later lines', () => {
    // A global regex reused across strings resumes from wherever it stopped,
    // which silently skips matches in the next line — the bug this test exists
    // for, because the symptom is a lower count rather than an error.
    const found = findClarifications(
      '[NEEDS CLARIFICATION: a] and [NEEDS CLARIFICATION: b]\n[NEEDS CLARIFICATION: c]',
    );
    expect(found.map((f) => f.question)).toEqual(['a', 'b', 'c']);
  });

  it('accepts a marker with no question, and records it as anonymous', () => {
    const found = findClarifications('[NEEDS CLARIFICATION]');
    expect(found[0]?.question).toBeNull();
  });

  it('matches the importer, case and all', () => {
    // `speckit.ts` already has a pattern for this. A second, subtly different
    // one is a vocabulary split — and a regex is a vocabulary.
    expect(findClarifications('[needs clarification: lower]')).toHaveLength(1);
  });

  it('does not match prose that merely mentions clarification', () => {
    expect(findClarifications('this needs clarification from the team')).toEqual([]);
  });
});

describe('the clarification gate', () => {
  it('is clear when nothing is outstanding', () => {
    expect(clarificationGate([]).clear).toBe(true);
  });

  it('blocks and names the lines', () => {
    // A spec with three unanswered questions that advances to `plan` produces a
    // plan built on three guesses, and the guesses are invisible by the time
    // anybody reads the plan.
    const gate = clarificationGate([
      { question: 'which timezone?', line: 4 },
      { question: 'which currency?', line: 9 },
    ]);
    expect(gate.clear).toBe(false);
    expect(gate.count).toBe(2);
    expect(gate.because).toContain('4, 9');
  });

  it('calls out markers that ask nothing', () => {
    // Worse than the ones that block: it blocks AND gives the reader nothing to
    // act on, because nobody but the author knows what was meant.
    const gate = clarificationGate([{ question: null, line: 2 }]);
    expect(gate.because).toContain('ask nothing');
  });

  it('never answers anything itself', () => {
    // Resolution is a human act. An agent resolving its own marker is an agent
    // deciding what the user meant.
    const gate = clarificationGate([{ question: 'which timezone?', line: 4 }]);
    expect(gate.because).toContain('nothing here answers them for you');
  });
});

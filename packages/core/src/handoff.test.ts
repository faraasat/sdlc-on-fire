import { describe, expect, it } from 'vitest';
import {
  SourcePointerSchema,
  StageHandoffSchema,
  handoffProblems,
  isUsableHandoff,
  type StageHandoff,
} from './handoff.js';

/**
 * P1-CTX-07 — the typed handoff (ADR-0021).
 *
 * The schema tests are cheap; the ones that matter are the continuity checks,
 * because those are what distinguish this from renaming a string field.
 */

function handoff(overrides: Partial<StageHandoff> = {}): StageHandoff {
  return StageHandoffSchema.parse({
    schema_version: '1',
    runId: 'run-1',
    workItemId: 'WI-1',
    from: 'plan',
    to: 'implement',
    openQuestions: [],
    ...overrides,
  });
}

describe('StageHandoffSchema', () => {
  it('defaults the list fields but requires openQuestions to be stated', () => {
    const parsed = handoff();
    expect(parsed.decisions).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.requiredInputs).toEqual([]);

    // The whole point of the field: silence and "nothing open" must not be the
    // same bytes on disk.
    const withoutQuestions = StageHandoffSchema.safeParse({
      schema_version: '1',
      runId: 'run-1',
      workItemId: 'WI-1',
      from: 'plan',
      to: 'implement',
    });
    expect(withoutQuestions.success).toBe(false);
  });

  it('rejects unknown fields rather than dropping them', () => {
    const result = StageHandoffSchema.safeParse({
      schema_version: '1',
      runId: 'run-1',
      workItemId: 'WI-1',
      from: 'plan',
      to: 'implement',
      openQuestions: [],
      summary: 'a free-text summary, which is what this replaces',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty open question, which is prose formatting rather than a question', () => {
    expect(StageHandoffSchema.safeParse({ ...handoff(), openQuestions: [''] }).success).toBe(false);
  });
});

describe('SourcePointerSchema', () => {
  it('rejects a backwards chunk range', () => {
    const result = SourcePointerSchema.safeParse({
      runId: 'run-1',
      stage: 'plan',
      artifact: 'notes.md',
      chunkFrom: 4,
      chunkTo: 2,
      contentHash: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a single-chunk range', () => {
    const result = SourcePointerSchema.safeParse({
      runId: 'run-1',
      stage: 'plan',
      artifact: 'notes.md',
      chunkFrom: 2,
      chunkTo: 2,
      contentHash: 'abc',
    });
    expect(result.success).toBe(true);
  });
});

describe('handoffProblems', () => {
  it('accepts a well-formed boundary', () => {
    expect(handoffProblems(handoff())).toEqual([]);
    expect(isUsableHandoff(handoff())).toBe(true);
  });

  it('refuses a handoff that does not cross a boundary', () => {
    const problems = handoffProblems(handoff({ from: 'plan', to: 'plan' }));
    expect(problems.map((problem) => problem.field)).toContain('to');
  });

  it('refuses a source pointer belonging to a different run', () => {
    const problems = handoffProblems(
      handoff({
        source: {
          runId: 'some-other-run',
          stage: 'plan',
          artifact: 'notes.md',
          chunkFrom: 0,
          chunkTo: 1,
          contentHash: 'abc',
        },
      }),
    );
    expect(problems.map((problem) => problem.field)).toContain('source.runId');
  });

  it('refuses a chain with a gap between stages', () => {
    const previous = handoff({ from: 'spec', to: 'plan' });
    const next = handoff({ from: 'implement', to: 'test' });
    const problems = handoffProblems(next, previous);
    expect(problems.map((problem) => problem.field)).toContain('from');
  });

  describe('open questions carried across a boundary', () => {
    const previous = handoff({
      from: 'spec',
      to: 'plan',
      openQuestions: ['does the importer need to handle CSV?', 'who owns the retry budget?'],
    });

    it('flags a question that is neither carried nor answered', () => {
      const next = handoff({
        from: 'plan',
        to: 'implement',
        openQuestions: ['who owns the retry budget?'],
      });
      const problems = handoffProblems(next, previous);
      expect(problems).toHaveLength(1);
      expect(problems[0]?.field).toBe('openQuestions');
      expect(problems[0]?.detail).toContain('CSV');
    });

    it('accepts a question carried forward verbatim', () => {
      const next = handoff({
        from: 'plan',
        to: 'implement',
        openQuestions: [...previous.openQuestions],
      });
      expect(handoffProblems(next, previous)).toEqual([]);
    });

    it('accepts a question closed by a decision that restates it', () => {
      const next = handoff({
        from: 'plan',
        to: 'implement',
        openQuestions: ['who owns the retry budget?'],
        decisions: [
          {
            statement: 'Does the importer need to handle CSV?',
            because: 'two of three pilot customers export CSV only',
          },
        ],
      });
      // Case and spacing differ from the original question; nothing else does.
      expect(handoffProblems(next, previous)).toEqual([]);
    });

    it('does not accept a merely similar decision as an answer', () => {
      const next = handoff({
        from: 'plan',
        to: 'implement',
        openQuestions: ['who owns the retry budget?'],
        decisions: [{ statement: 'CSV support', because: 'pilot customers asked' }],
      });
      // A looser match would let any decision mentioning the topic close any
      // question about it, which is how a question gets "resolved" by being
      // gestured at.
      expect(handoffProblems(next, previous)).toHaveLength(1);
    });

    it('flags every dropped question, not just the first', () => {
      const next = handoff({ from: 'plan', to: 'implement', openQuestions: [] });
      expect(handoffProblems(next, previous)).toHaveLength(2);
    });
  });
});

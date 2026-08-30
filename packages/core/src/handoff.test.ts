import { describe, expect, it } from 'vitest';
import {
  AuthoredHandoffSchema,
  HANDOFF_TOKEN_CAP,
  HANDOFF_TRIM_PRIORITY,
  handoffOverflowReprompt,
  handoffSize,
  type AuthoredHandoff,
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

/**
 * The size cap (P8-EVID-03, Q-07).
 *
 * contracts/05 §4 stated a "~1–2K-token cap" and Q-07 left enforcement to
 * "decide during P1-CTX-07". P1-CTX-07 shipped and nothing enforced anything —
 * checked by reading the code rather than trusting the task's `done`. These
 * tests are the decision: reject and reprompt, never silent truncation, and
 * never at the cost of `openQuestions`.
 */
describe('the handoff size cap', () => {
  const authored = (over: Partial<AuthoredHandoff> = {}): AuthoredHandoff =>
    AuthoredHandoffSchema.parse({
      decisions: [],
      openQuestions: [],
      artifacts: [],
      requiredInputs: [],
      notes: '',
      ...over,
    });

  it('passes a small handoff', () => {
    const size = handoffSize(authored({ notes: 'short' }));
    expect(size.withinCap).toBe(true);
    expect(handoffOverflowReprompt(authored({ notes: 'short' }))).toBeNull();
  });

  it('refuses one over the cap', () => {
    const size = handoffSize(authored({ notes: 'x'.repeat(HANDOFF_TOKEN_CAP * 4 + 100) }));
    expect(size.withinCap).toBe(false);
    expect(size.because).toContain('over by');
  });

  it('measures the serialized object, not the sum of the fields', () => {
    // JSON punctuation and key names are real bytes the next stage pays for. A
    // per-field sum under-reports by exactly the amount that lets a borderline
    // handoff through.
    const handoff = authored({ artifacts: ['a', 'b', 'c'], requiredInputs: ['d'] });
    const fieldSum = handoffSize(handoff).byField.reduce((sum, e) => sum + e.tokens, 0);
    expect(handoffSize(handoff).tokens).toBeGreaterThan(fieldSum);
  });

  it('caps at the top of the stated range, not the bottom', () => {
    // contracts/05 says "~1–2K". Enforcing 1000 would make a document that says
    // 1–2K describe something that refuses at 1K.
    expect(HANDOFF_TOKEN_CAP).toBe(2000);
  });

  it('names the fields to shorten, in priority order', () => {
    const message = handoffOverflowReprompt(
      authored({
        notes: 'n'.repeat(9000),
        artifacts: Array.from({ length: 300 }, (_, i) => `artifact-${String(i)}`),
      }),
    );
    expect(message).toContain('notes, artifacts');
  });

  it('never offers openQuestions as something to shorten', () => {
    // The obvious way for an author to get under a limit is to drop the list of
    // things it does not know, which is the single worst edit available.
    const message = handoffOverflowReprompt(
      authored({
        notes: 'n'.repeat(9000),
        openQuestions: Array.from({ length: 50 }, (_, i) => `question ${String(i)}`),
      }),
    );
    expect(message).toContain('Never drop openQuestions');
    expect(HANDOFF_TRIM_PRIORITY).not.toContain('openQuestions');
  });

  it('says to split the work when the protected fields alone exceed the cap', () => {
    // Trimming cannot help here, and telling somebody to shorten `notes` when
    // `notes` is empty is advice that wastes a turn.
    const message = handoffOverflowReprompt(authored({ openQuestions: [`q ${'x'.repeat(9000)}`] }));
    expect(message).toContain('split the work');
  });

  it('refuses at exactly one token over, not one token later', () => {
    // An off-by-one on a boundary check is the classic way a cap becomes
    // advisory. Constructed to land exactly on the cap, then pushed one over.
    const atCap = 'n'.repeat(HANDOFF_TOKEN_CAP * 4 - 200);
    const exact = handoffSize(authored({ notes: atCap }));
    expect(exact.withinCap).toBe(true);
    const over = handoffSize(authored({ notes: atCap }), exact.tokens - 1);
    expect(over.withinCap).toBe(false);
    expect(handoffSize(authored({ notes: atCap }), exact.tokens).withinCap).toBe(true);
  });

  it('offers the trim order by priority, not by which field happens to be biggest', () => {
    // The priority is a judgement about what is cheap to lose — notes first
    // because it is explicitly free text, decisions last because losing one
    // loses the record of why. Sorting by size instead would recommend dropping
    // decisions first whenever a run made a lot of them.
    const message = handoffOverflowReprompt(
      authored({
        notes: 'n'.repeat(400),
        decisions: Array.from({ length: 200 }, (_, i) => ({
          statement: `decision ${String(i)} ${'d'.repeat(40)}`,
          because: 'it was the cheapest reversible option',
        })),
      }),
    );
    expect(message).toContain('Shorten in this order: notes, decisions');
  });

  it('reports fields largest-first so the reprompt leads with what matters', () => {
    const size = handoffSize(
      authored({ notes: 'n'.repeat(400), artifacts: ['a'], requiredInputs: [] }),
    );
    const tokens = size.byField.map((entry) => entry.tokens);
    expect(tokens).toEqual([...tokens].sort((a, b) => b - a));
  });

  it('is deterministic — the same handoff measures the same twice', () => {
    const handoff = authored({ notes: 'n'.repeat(500) });
    expect(handoffSize(handoff)).toEqual(handoffSize(handoff));
  });

  it('accepts a caller-supplied cap, so a stage can be stricter than the default', () => {
    const handoff = authored({ notes: 'n'.repeat(100) });
    expect(handoffSize(handoff, 10).withinCap).toBe(false);
    expect(handoffSize(handoff, 10_000).withinCap).toBe(true);
  });
});

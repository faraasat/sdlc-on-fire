import { describe, expect, it } from 'vitest';
import {
  annotateSuperseded,
  recordState,
  renderState,
  STATE_ENTRY_MAX_CHARS,
  StateEntryTooLong,
  type StateEntry,
} from './rolling-state.js';

const entry = (over: Partial<StateEntry> = {}): StateEntry => ({
  stage: 'spec',
  decided: 'scope narrowed to CSV only; multi-currency is out',
  recordedAt: '2026-08-24T00:00:00.000Z',
  ...over,
});

describe('rolling STATE (P6-PERSTAGE-04, FEAT-CTX-016)', () => {
  it('keeps one entry per stage, in ladder order', () => {
    // A single overwritten blob loses the sequence, and the sequence is the
    // interesting part: "narrowed at spec, widened at plan" is invisible in a
    // blob that only holds the latest.
    const state = recordState(
      recordState([], entry({ stage: 'plan', decided: 'three tasks' })),
      entry({ stage: 'spec' }),
    );
    expect(state.map((row) => row.stage)).toEqual(['spec', 'plan']);
  });

  it('replaces a stage rather than recording it twice', () => {
    // A stage re-entered after a reopen has one current answer. Two entries for
    // `implement` leave a reader to guess which is live.
    const state = recordState(
      recordState([], entry({ stage: 'implement', decided: 'first attempt' })),
      entry({ stage: 'implement', decided: 'second attempt' }),
    );
    expect(state).toHaveLength(1);
    expect(state[0]?.decided).toBe('second attempt');
  });

  it('refuses an over-long entry rather than truncating it', () => {
    // A summary cut mid-sentence reads as complete and is not — the reader has
    // no way to know a clause is missing, which is worse than having none.
    expect(() =>
      recordState([], entry({ decided: 'x'.repeat(STATE_ENTRY_MAX_CHARS + 1) })),
    ).toThrow(StateEntryTooLong);
  });

  it('says what to do about it in the refusal', () => {
    // A limit that reports only the number leaves the writer to guess whether to
    // cut words or to write a different kind of thing.
    expect(() => recordState([], entry({ decided: 'x'.repeat(2000) }))).toThrow(
      /Summarise what was decided/,
    );
  });

  it('renders nothing at all when no stage has spoken', () => {
    // `undefined`, not an empty heading. A layer containing only a title spends
    // tokens to say nothing and reads as a stage that summarised badly.
    expect(renderState([])).toBeUndefined();
  });

  it('renders each stage on its own line', () => {
    const text = renderState([entry(), entry({ stage: 'plan', decided: 'three tasks' })]);
    expect(text).toContain('**spec**');
    expect(text).toContain('**plan**');
  });
});

describe('superseded decisions in retrieval (FEAT-CTX-017)', () => {
  it('annotates rather than filters', () => {
    // Dropping them hides history a reader sometimes needs, and means a query
    // whose only answer is superseded returns nothing — which reads as "we never
    // decided this".
    const annotated = annotateSuperseded({
      id: 'ADR-0003',
      text: 'Postgres is provisioned by the user.',
      status: 'superseded',
      supersededBy: 'ADR-0068',
    });
    expect(annotated.stale).toBe(true);
    expect(annotated.text).toContain('Postgres is provisioned by the user.');
  });

  it('puts the warning before the content', () => {
    // A note appended after four hundred words of superseded reasoning arrives
    // after the model has already read the reasoning as current. Position is the
    // whole mechanism.
    const annotated = annotateSuperseded({
      id: 'ADR-0003',
      text: 'body',
      supersededBy: 'ADR-0068',
    });
    expect(annotated.text.indexOf('SUPERSEDED')).toBeLessThan(annotated.text.indexOf('body'));
    expect(annotated.text).toContain('ADR-0068');
  });

  it('marks a superseded decision with no replacement recorded', () => {
    // Still stale. Saying "superseded" and naming nothing is more honest than
    // returning it as current because the pointer is missing.
    const annotated = annotateSuperseded({ id: 'ADR-0009', text: 'body', status: 'superseded' });
    expect(annotated.stale).toBe(true);
    expect(annotated.text).toContain('no replacement recorded');
  });

  it('leaves a current decision untouched', () => {
    // Byte-identical, because this text may sit inside a cacheable prefix and a
    // cosmetic change to every chunk would invalidate the cache for nothing.
    const current = annotateSuperseded({ id: 'ADR-0074', text: 'body', status: 'accepted' });
    expect(current.stale).toBe(false);
    expect(current.text).toBe('body');
  });

  it('treats a superseded_by pointer as stale even when the status says otherwise', () => {
    // Two fields, one truth. A decision pointing at a replacement is superseded
    // whatever its status field says, and trusting the status alone lets a
    // half-applied edit return stale guidance as current.
    const annotated = annotateSuperseded({
      id: 'ADR-0010',
      text: 'body',
      status: 'accepted',
      supersededBy: 'ADR-0035',
    });
    expect(annotated.stale).toBe(true);
  });
});

import { LIFECYCLE_STAGES, type LifecycleStage } from './lifecycle.js';

/**
 * Rolling STATE and superseded-decision surfacing (P6-PERSTAGE-04;
 * FEAT-CTX-016, FEAT-CTX-017).
 *
 * ## Rolling STATE
 *
 * The pack already has a `rolling-state` layer and nothing has ever produced
 * one. Without it, a card at `review` either carries its whole prior transcript
 * — growing linearly with stage count — or carries nothing and the reviewer
 * re-derives what the spec stage already decided.
 *
 * Three rules, and each is a way a rolling summary usually rots.
 *
 * **It is per stage, and every stage's entry is kept.** A single overwritten
 * blob loses the sequence, and the sequence is the interesting part: "we
 * narrowed scope at spec and widened it at plan" is invisible in a blob that
 * only holds the latest.
 *
 * **It is bounded per entry, and the bound is enforced by refusal rather than
 * by truncation.** Silently cutting a summary mid-sentence produces text that
 * reads as complete and is not, which is worse than none — the reader has no
 * way to know a clause is missing.
 *
 * **A stage that summarised nothing says so.** An absent entry and an entry that
 * says "no decisions were taken here" are different facts, and the second is
 * often the one that explains why the next stage struggled.
 */

/** Roughly two paragraphs. Big enough for what was decided, too small for a transcript. */
export const STATE_ENTRY_MAX_CHARS = 1200;

export interface StateEntry {
  readonly stage: LifecycleStage;
  /** What this stage decided. Never what it did — the transcript is not this. */
  readonly decided: string;
  readonly recordedAt: string;
}

export class StateEntryTooLong extends Error {
  override readonly name = 'StateEntryTooLong';
  constructor(stage: string, length: number) {
    super(
      `the ${stage} STATE entry is ${String(length)} characters; the limit is ${String(STATE_ENTRY_MAX_CHARS)}. ` +
        'Summarise what was decided rather than what happened — this is not a transcript, and it is not truncated for you ' +
        'because a summary cut mid-sentence reads as complete and is not.',
    );
  }
}

/**
 * Appends a stage's entry, replacing that stage's previous one.
 *
 * Replacing rather than appending twice: a stage re-entered after a reopen has
 * one current answer, and two entries for `implement` leave a reader to guess
 * which is live. The *order* is the lifecycle's, not insertion order, so a
 * reopened card still reads in ladder order.
 */
export function recordState(
  existing: readonly StateEntry[],
  entry: StateEntry,
): readonly StateEntry[] {
  if (entry.decided.length > STATE_ENTRY_MAX_CHARS) {
    throw new StateEntryTooLong(entry.stage, entry.decided.length);
  }
  const kept = existing.filter((row) => row.stage !== entry.stage);
  return [...kept, entry].sort(
    (a, b) => LIFECYCLE_STAGES.indexOf(a.stage) - LIFECYCLE_STAGES.indexOf(b.stage),
  );
}

/** The `rolling-state` layer's content, or `undefined` when there is nothing to say. */
export function renderState(entries: readonly StateEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return [
    '## What earlier stages decided',
    '',
    ...entries.map((entry) => `- **${entry.stage}**: ${entry.decided}`),
  ].join('\n');
}

/* -------------------------------------------------------------------------- */

/**
 * Superseded-decision surfacing in retrieval (FEAT-CTX-017).
 *
 * `docs.ts` has known about `superseded_by` since P1; retrieval never surfaced
 * it, so a stale ADR came back looking exactly like a current one. An agent then
 * acts on it confidently, which is the failure mode worth spending a line of
 * output on.
 *
 * **Annotated, never filtered out.** Dropping superseded decisions would hide
 * the history a reader sometimes needs — "why did we stop doing it that way" is
 * a real question — and would also mean a query whose only answer is superseded
 * returns nothing at all, which reads as "we never decided this".
 */
export interface RetrievedDecision {
  readonly id: string;
  readonly text: string;
  readonly status?: string | undefined;
  readonly supersededBy?: string | null | undefined;
}

export interface AnnotatedChunk {
  readonly id: string;
  readonly text: string;
  /** True when the reader must not act on this as current guidance. */
  readonly stale: boolean;
}

export function annotateSuperseded(chunk: RetrievedDecision): AnnotatedChunk {
  const stale = chunk.status === 'superseded' || (chunk.supersededBy ?? null) !== null;
  if (!stale) return { id: chunk.id, text: chunk.text, stale: false };

  // The marker goes FIRST, before the content. A note appended after four
  // hundred words of superseded reasoning arrives after the model has already
  // read the reasoning as current — position is the whole mechanism here.
  const pointer =
    (chunk.supersededBy ?? null) === null
      ? 'superseded — no replacement recorded'
      : `superseded by ${String(chunk.supersededBy)}`;
  return {
    id: chunk.id,
    text: `> ⚠ SUPERSEDED (${pointer}). Do not act on this as current guidance.\n\n${chunk.text}`,
    stale: true,
  };
}

/**
 * `[NEEDS CLARIFICATION]` in our own artifacts (P6-SURFACE-05; FEAT-GOV-004/005).
 *
 * The marker exists in this codebase only inside the **Spec Kit importer**,
 * where `speckit.ts` carries it across without resolving it — deliberately, and
 * correctly, because an importer that answers somebody else's open question is
 * making a decision nobody asked it to. What was missing is the other half: our
 * own specs could not carry one, so a question raised during a spec had nowhere
 * to live except prose, where nothing counts it and nothing blocks on it.
 *
 * **A marker is a blocker, not a note.** The whole reason to write one down is
 * that the work should not proceed past it — a spec with three unanswered
 * questions that advances to `plan` produces a plan built on three guesses, and
 * the guesses are invisible by the time anybody reads the plan.
 *
 * **Resolution is a human act.** Nothing here answers a question; it finds them,
 * counts them, and refuses to let a stage close over them. An agent resolving
 * its own `[NEEDS CLARIFICATION]` is an agent deciding what the user meant.
 */

/**
 * The marker, with an optional question after a colon.
 *
 * Case-insensitive and tolerant of the bracket contents, matching the importer's
 * pattern rather than a second, subtly different one — this repository has found
 * two copies of a vocabulary that were never in the same room six times, and a
 * regex is a vocabulary.
 */
const MARKER = /\[NEEDS CLARIFICATION(?::\s*([^\]]*))?\]/gi;

export interface Clarification {
  /** The question, when one was written after the colon. */
  readonly question: string | null;
  /** 1-based line number in the artifact, so the reader can go to it. */
  readonly line: number;
}

/**
 * Every marker in a document.
 *
 * Returns line numbers rather than offsets. An offset is correct and useless: a
 * person reading "unresolved at character 4,182" goes and counts.
 */
export function findClarifications(text: string): readonly Clarification[] {
  const found: Clarification[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    // No `lastIndex` reset. The loop below runs each line to exhaustion, and
    // `exec` returning null resets `lastIndex` to 0 itself — so a reset here is
    // dead. It was written, and mutation testing showed nothing depended on it.
    // A dead guard reads exactly like a live one, so it is removed rather than
    // tested around. (The reset WOULD be needed if this ever stopped early.)
    let match: RegExpExecArray | null;
    while ((match = MARKER.exec(line)) !== null) {
      const question = (match[1] ?? '').trim();
      found.push({ question: question.length === 0 ? null : question, line: index + 1 });
    }
  }
  return found;
}

export interface ClarificationGate {
  readonly clear: boolean;
  readonly count: number;
  /** What to say to whoever is blocked, naming lines rather than counts alone. */
  readonly because: string;
}

/**
 * Whether a stage may close with these markers outstanding.
 *
 * Anonymous markers — `[NEEDS CLARIFICATION]` with no question — are counted and
 * called out separately. A marker with no question cannot be answered by anybody
 * who did not write it, which makes it worse than the ones that block: it blocks
 * *and* gives the reader nothing to act on.
 */
export function clarificationGate(found: readonly Clarification[]): ClarificationGate {
  if (found.length === 0) {
    return { clear: true, count: 0, because: 'no clarifications are outstanding' };
  }
  const anonymous = found.filter((item) => item.question === null);
  const lines = found.map((item) => String(item.line)).join(', ');
  return {
    clear: false,
    count: found.length,
    because:
      `${String(found.length)} unresolved [NEEDS CLARIFICATION] marker(s) at line(s) ${lines}. ` +
      (anonymous.length > 0
        ? `${String(anonymous.length)} of them ask nothing — a marker with no question cannot be answered by anybody who did not write it. `
        : '') +
      'Answer them in the artifact and remove the markers; nothing here answers them for you.',
  };
}

import { z } from 'zod';

/**
 * Requirement echo-back and its approval gate (P1-LIFE-05, ADR-0049).
 *
 * The most common way agentic work goes wrong is not bad code — it is building
 * the wrong thing, because the agent read an ambiguous prompt one way and never
 * checked. So before an item leaves intake, the agent restates what it
 * understood, names its assumptions, asks what it cannot resolve, and waits.
 *
 * **The human is the disposer here** (ADR-0040). The agent proposes an
 * understanding; the agent's own confidence in that understanding authorizes
 * nothing. That is the one thing this module must make structurally true rather
 * than merely encouraged, so an echo-back can never approve itself and an
 * `actorKind: 'agent'` approval is not representable as a pass.
 *
 * **Right-sized, not fatiguing** (ADR-0049, §consolidated policy). Ceremony
 * scales to ambiguity: an unambiguous ask gets one line, and a workspace may
 * auto-approve that case explicitly. Approval fatigue is a documented oversight
 * failure — a gate that fires on everything trains people to click through it,
 * which costs more than the gate saves.
 */

/** The agent's own read of the request. Advisory — it can only ever loosen with consent. */
export const AMBIGUITY_LEVELS = ['low', 'medium', 'high'] as const;
export const AmbiguitySchema = z.enum(AMBIGUITY_LEVELS);
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

/** One thing the agent decided for itself, and would like contradicted if wrong. */
export const AssumptionSchema = z
  .object({
    statement: z.string().min(1),
    /** What the agent will do if nobody says otherwise. */
    ifUnchallenged: z.string().min(1),
  })
  .strict();

export const EchoBackSchema = z
  .object({
    workItemId: z.string().min(1),
    /** The restatement: tight, not a re-dump of the prompt (ADR-0053). */
    understanding: z.string().min(1),
    scope: z.array(z.string().min(1)).default([]),
    /** What the agent read as deliberately out of scope. */
    outOfScope: z.array(z.string().min(1)).default([]),
    assumptions: z.array(AssumptionSchema).default([]),
    /**
     * Questions the agent cannot answer from what it was given.
     *
     * Required, and empty is legitimate — but it must be *stated* empty, for the
     * same reason a stage handoff states its open questions: a field that may be
     * omitted is one a summarising model will omit.
     */
    questions: z.array(z.string().min(1)),
    /** The agent's own read of how ambiguous the request was. Advisory only. */
    ambiguity: AmbiguitySchema,
  })
  .strict();

export type EchoBack = z.infer<typeof EchoBackSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;

export const ApprovalSchema = z
  .object({
    actor: z.string().min(1),
    /**
     * Humans only, structurally.
     *
     * Not a policy toggle: an agent-authored approval of an agent's own
     * understanding is the exact circularity this gate exists to break, so the
     * type cannot express it (architecture §5 — agents are actors, never
     * approvers).
     */
    actorKind: z.literal('human'),
    decision: z.enum(['approved', 'corrected']),
    /** Answers to the questions asked, in order. */
    answers: z.array(z.string()).default([]),
    /** What the human changed about the agent's understanding. */
    corrections: z.array(z.string().min(1)).default([]),
    at: z.iso.datetime(),
  })
  .strict();

export type EchoBackApproval = z.infer<typeof ApprovalSchema>;

export type EchoBackVerdict =
  | { readonly ok: true; readonly reason: 'approved' | 'auto-approved' }
  | { readonly ok: false; readonly reason: string };

export interface EchoBackPolicy {
  /**
   * Skip the wait when the agent read the request as unambiguous and asked
   * nothing (ADR-0049's right-sizing clause).
   *
   * Off by default. The setting is the user's to make, and defaulting it on
   * would let the agent decide when it needs supervision — which is the same
   * circularity in a different place.
   */
  readonly autoApproveUnambiguous?: boolean | undefined;
}

/**
 * Whether an echo-back has cleared its gate.
 *
 * The order matters. An echo-back with unanswered questions is refused *before*
 * any auto-approval is considered: the agent asked, so by its own account it
 * does not have what it needs, and a setting about unambiguous requests has
 * nothing to say about one the agent called ambiguous.
 */
export function checkEchoBack(
  echo: EchoBack,
  approval: EchoBackApproval | undefined,
  policy: EchoBackPolicy = {},
): EchoBackVerdict {
  if (approval !== undefined) {
    if (approval.decision === 'corrected' && approval.corrections.length === 0) {
      return {
        ok: false,
        reason:
          'the approval says the understanding was corrected but records no correction — ' +
          'what changed has to be written down, or the next stage proceeds on the old reading',
      };
    }
    if (approval.answers.length < echo.questions.length) {
      return {
        ok: false,
        reason:
          `${String(echo.questions.length - approval.answers.length)} question(s) went unanswered — ` +
          'an approval that skips the questions approves an understanding nobody completed',
      };
    }
    return { ok: true, reason: 'approved' };
  }

  if (
    policy.autoApproveUnambiguous === true &&
    echo.ambiguity === 'low' &&
    echo.questions.length === 0
  ) {
    return { ok: true, reason: 'auto-approved' };
  }

  return {
    ok: false,
    reason:
      `${echo.workItemId} has not had its restated understanding approved. The agent proposes an ` +
      'understanding; it never authorizes proceeding on one — record the human decision with ' +
      '`sdlc echo approve`.',
  };
}

/** Renders the exchange for `qna.md` (contracts/06, ADR-0049). */
export function renderQna(echo: EchoBack, approval?: EchoBackApproval): string {
  const lines = [`## ${echo.workItemId} — restated understanding`, '', echo.understanding, ''];
  if (echo.scope.length > 0) {
    lines.push('**In scope**', ...echo.scope.map((entry) => `- ${entry}`), '');
  }
  if (echo.outOfScope.length > 0) {
    lines.push('**Not in scope**', ...echo.outOfScope.map((entry) => `- ${entry}`), '');
  }
  if (echo.assumptions.length > 0) {
    lines.push(
      '**Assumptions** — each says what happens if nobody objects, so silence is not mistaken for agreement.',
      ...echo.assumptions.map(
        (entry) => `- ${entry.statement} → if unchallenged: ${entry.ifUnchallenged}`,
      ),
      '',
    );
  }

  lines.push('**Questions**');
  if (echo.questions.length === 0) {
    lines.push('- (none — the agent read this as unambiguous)');
  } else {
    for (const [index, question] of echo.questions.entries()) {
      lines.push(`${String(index + 1)}. ${question}`);
      const answer = approval?.answers[index];
      // An unanswered question is shown as unanswered rather than omitted. A
      // Q&A log that quietly drops what nobody answered reads, later, as though
      // it was never asked.
      lines.push(
        `   → ${answer === undefined || answer.trim() === '' ? '_(unanswered)_' : answer}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Renders the decision for `human-loop.md` — who decided, when, and what changed. */
export function renderHumanLoop(echo: EchoBack, approval: EchoBackApproval): string {
  const lines = [
    `## ${echo.workItemId} — intake approval`,
    '',
    `- **decided by:** ${approval.actor} (human)`,
    `- **decision:** ${approval.decision}`,
    `- **at:** ${approval.at}`,
  ];
  if (approval.corrections.length > 0) {
    lines.push('- **corrections:**', ...approval.corrections.map((entry) => `  - ${entry}`));
  }
  lines.push('');
  return lines.join('\n');
}

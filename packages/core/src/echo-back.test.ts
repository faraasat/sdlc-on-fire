import { describe, expect, it } from 'vitest';
import {
  ApprovalSchema,
  EchoBackSchema,
  checkEchoBack,
  renderHumanLoop,
  renderQna,
  type EchoBack,
} from './echo-back.js';

/**
 * P1-LIFE-05 — requirement echo-back (ADR-0049).
 *
 * The gate exists because the common failure is building the wrong thing, not
 * building it badly. So the tests are about who is allowed to say the
 * understanding is right, and about the gate not becoming a reflex.
 */

const echo = (over: Partial<EchoBack> = {}): EchoBack =>
  EchoBackSchema.parse({
    workItemId: 'FEAT-001',
    understanding: 'Import CSV files exported by the billing system into the ledger.',
    scope: ['CSV parsing', 'row-level error reporting'],
    outOfScope: ['multi-currency'],
    questions: [],
    ambiguity: 'low',
    ...over,
  });

const approval = (over: Record<string, unknown> = {}) =>
  ApprovalSchema.parse({
    actor: 'ana',
    actorKind: 'human',
    decision: 'approved',
    at: '2026-08-10T00:00:00.000Z',
    ...over,
  });

describe('the schema', () => {
  it('requires questions to be stated, even when empty', () => {
    const missing = EchoBackSchema.safeParse({
      workItemId: 'FEAT-001',
      understanding: 'x',
      ambiguity: 'low',
    });
    // A field that may be omitted is one a summarising model will omit, and
    // "no questions" and "we forgot to ask" would be the same bytes.
    expect(missing.success).toBe(false);
  });

  it('cannot express an agent approval', () => {
    const byAgent = ApprovalSchema.safeParse({
      actor: 'claude',
      actorKind: 'agent',
      decision: 'approved',
      at: '2026-08-10T00:00:00.000Z',
    });
    // Not a policy toggle. An agent approving its own understanding is the exact
    // circularity this gate breaks, so the type cannot say it.
    expect(byAgent.success).toBe(false);
  });

  it('makes an assumption say what happens if nobody objects', () => {
    const vague = EchoBackSchema.safeParse({
      ...echo(),
      assumptions: [{ statement: 'dates are ISO-8601' }],
    });
    expect(vague.success).toBe(false);
  });
});

describe('checkEchoBack', () => {
  it('refuses an unapproved echo-back', () => {
    const verdict = checkEchoBack(echo(), undefined);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('never authorizes proceeding');
  });

  it('passes once a human approved', () => {
    expect(checkEchoBack(echo(), approval())).toEqual({ ok: true, reason: 'approved' });
  });

  it('refuses an approval that skipped the questions', () => {
    const verdict = checkEchoBack(
      echo({ questions: ['Which currency?', 'Which timezone?'] }),
      approval({ answers: ['GBP'] }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('unanswered');
  });

  it('refuses a correction that records nothing', () => {
    const verdict = checkEchoBack(echo(), approval({ decision: 'corrected' }));
    // Otherwise the next stage proceeds on the old reading while the record
    // says it was corrected.
    expect(verdict.ok).toBe(false);
  });

  it('accepts a correction that says what changed', () => {
    const verdict = checkEchoBack(
      echo(),
      approval({ decision: 'corrected', corrections: ['it is TSV, not CSV'] }),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('right-sizing (ADR-0049)', () => {
  it('does not auto-approve by default', () => {
    // Defaulting this on would let the agent decide when it needs supervision.
    expect(checkEchoBack(echo(), undefined, {}).ok).toBe(false);
  });

  it('auto-approves an unambiguous ask when the workspace asked for that', () => {
    const verdict = checkEchoBack(echo(), undefined, { autoApproveUnambiguous: true });
    expect(verdict).toEqual({ ok: true, reason: 'auto-approved' });
  });

  it('never auto-approves when the agent itself asked something', () => {
    const verdict = checkEchoBack(echo({ questions: ['Which currency?'] }), undefined, {
      autoApproveUnambiguous: true,
    });
    // The agent asked, so by its own account it does not have what it needs. A
    // setting about unambiguous requests has nothing to say about this one.
    expect(verdict.ok).toBe(false);
  });

  it('never auto-approves when the agent called the request ambiguous', () => {
    const verdict = checkEchoBack(echo({ ambiguity: 'high' }), undefined, {
      autoApproveUnambiguous: true,
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('the durable record (contracts/06)', () => {
  it('shows an unanswered question as unanswered rather than dropping it', () => {
    const text = renderQna(
      echo({ questions: ['Which currency?', 'Which timezone?'] }),
      approval({ answers: ['GBP'] }),
    );
    expect(text).toContain('GBP');
    // A Q&A log that quietly drops what nobody answered reads, later, as though
    // it was never asked.
    expect(text).toContain('_(unanswered)_');
  });

  it('says plainly when nothing was asked', () => {
    expect(renderQna(echo())).toContain('read this as unambiguous');
  });

  it('records who decided and what they changed', () => {
    const text = renderHumanLoop(
      echo(),
      approval({ decision: 'corrected', corrections: ['it is TSV, not CSV'] }),
    );
    expect(text).toContain('ana (human)');
    expect(text).toContain('TSV');
  });
});

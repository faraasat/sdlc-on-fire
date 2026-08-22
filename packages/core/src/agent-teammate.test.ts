import { describe, expect, it } from 'vitest';
import {
  actorBadge,
  believedAt,
  claimStanding,
  contested,
  memoryFor,
  type AgentClaim,
  type BitemporalRow,
} from './agent-teammate.js';
import type { Actor } from './capability.js';

/**
 * P3-RBAC-09 — agents as teammates who are visibly not people.
 *
 * "Agents are actors, never approvers" is a structural rule that lives in the
 * database and dies on the screen, because everything a person knows about who
 * did what comes from what they can see.
 */

const agent: Actor = { id: 'a1', kind: 'agent', displayName: 'claude-code' };
const human: Actor = { id: 'h1', kind: 'human', displayName: 'Ada' };

describe('actorBadge', () => {
  it('marks an agent as an agent, in the label itself', () => {
    const badge = actorBadge(agent);
    expect(badge.label).toContain('(agent)');
    expect(badge.nonHuman).toBe(true);
  });

  it('leaves a human unmarked', () => {
    expect(actorBadge(human).label).toBe('Ada');
    expect(actorBadge(human).nonHuman).toBe(false);
  });

  it('says what an agent cannot do, not just what it is', () => {
    expect(actorBadge(agent).title).toContain('cannot approve');
  });

  it('offers no way to render an actor without its kind', () => {
    // A helper that could omit the kind would be reached for by the one
    // component that later renders an agent as a person, and that component is
    // the whole problem.
    const badge = actorBadge(agent);
    expect(Object.keys(badge).sort()).toEqual(['kind', 'label', 'nonHuman', 'title']);
    expect(badge.label).not.toBe(agent.displayName);
  });
});

describe('claimStanding', () => {
  const claim = (over: Partial<AgentClaim> = {}): AgentClaim => ({
    actor: agent,
    cardId: 'FEAT-1',
    assertion: 'the tests pass',
    evidenceIds: [],
    ...over,
  });

  it('calls an agent’s unbacked assertion a proposal', () => {
    // "The tests pass" from an agent with no envelope behind it is exactly the
    // sentence this product exists to refuse. Rendering it like a backed claim
    // would make the board the place the refusal stops applying.
    const verdict = claimStanding(claim());
    expect(verdict.standing).toBe('proposal-pending-evidence');
    expect(verdict.label).toContain('pending evidence');
    expect(verdict.because).toContain('not a result');
  });

  it('accepts a backed claim as evidenced, whoever made it', () => {
    expect(claimStanding(claim({ evidenceIds: [1, 2] })).standing).toBe('evidenced');
    expect(claimStanding(claim({ actor: human, evidenceIds: [1] })).standing).toBe('evidenced');
  });

  it('labels a human’s unbacked assertion differently — accountability, not reliability', () => {
    // A person is not more likely to be right. A person can be asked why.
    const verdict = claimStanding(claim({ actor: human }));
    expect(verdict.standing).toBe('human-asserted');
    expect(verdict.because).toContain('can be asked why');
  });

  it('never lets an agent reach the same standing as evidence', () => {
    const unbacked = claimStanding(claim());
    expect(unbacked.standing).not.toBe('evidenced');
    expect(unbacked.standing).not.toBe('human-asserted');
  });
});

describe('believedAt', () => {
  const row = (over: Partial<BitemporalRow> = {}): BitemporalRow => ({
    id: 1,
    written_by: 'claude-code:run-7',
    valid_from: '2026-08-01T00:00:00Z',
    valid_to: null,
    ...over,
  });

  it('is true for an open row after its start', () => {
    expect(believedAt(row(), new Date('2026-08-10T00:00:00Z'))).toBe(true);
  });

  it('is false before the row existed', () => {
    // The question "what did we believe on Tuesday" is how you work out why an
    // agent did something on Tuesday, and it is wrong if a row counts before it
    // was written.
    expect(believedAt(row(), new Date('2026-07-01T00:00:00Z'))).toBe(false);
  });

  it('is false after the row was closed', () => {
    const closed = row({ valid_to: '2026-08-05T00:00:00Z' });
    expect(believedAt(closed, new Date('2026-08-10T00:00:00Z'))).toBe(false);
    expect(believedAt(closed, new Date('2026-08-03T00:00:00Z'))).toBe(true);
  });

  it('treats an unparseable close as still open rather than as never true', () => {
    // Erring towards "we believed this" is the safe direction: dropping a row
    // makes an investigation silently incomplete.
    expect(believedAt(row({ valid_to: 'whenever' }), new Date('2026-08-10T00:00:00Z'))).toBe(true);
  });
});

describe('memoryFor', () => {
  const rows: BitemporalRow[] = [
    { id: 1, written_by: 'claude-code:run-1', valid_from: '2026-08-01T00:00:00Z', valid_to: null },
    {
      id: 2,
      written_by: 'claude-code:run-2',
      valid_from: '2026-08-01T00:00:00Z',
      valid_to: '2026-08-02T00:00:00Z',
    },
    { id: 3, written_by: 'codex:run-9', valid_from: '2026-08-01T00:00:00Z', valid_to: null },
  ];

  it('scopes to one actor', () => {
    expect(
      memoryFor(rows, 'claude-code', new Date('2026-08-10T00:00:00Z')).map((r) => r.id),
    ).toEqual([1]);
  });

  it('returns every actor’s live rows when unscoped', () => {
    expect(memoryFor(rows, null, new Date('2026-08-10T00:00:00Z')).map((r) => r.id)).toEqual([
      1, 3,
    ]);
  });

  it('excludes rows closed before the instant asked about', () => {
    expect(memoryFor(rows, null, new Date('2026-08-01T12:00:00Z')).map((r) => r.id)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('contested', () => {
  it('reports live disagreements rather than resolving them', () => {
    // Picking a winner is a judgement. A store that silently prefers the newer
    // claim hides the moment an agent changed its mind about something that
    // mattered.
    const rows: BitemporalRow[] = [
      {
        id: 1,
        written_by: 'a',
        valid_from: '2026-08-01T00:00:00Z',
        valid_to: null,
        conflict_status: 'contested',
      },
      {
        id: 2,
        written_by: 'a',
        valid_from: '2026-08-01T00:00:00Z',
        valid_to: '2026-08-02T00:00:00Z',
        conflict_status: 'contested',
      },
      {
        id: 3,
        written_by: 'a',
        valid_from: '2026-08-01T00:00:00Z',
        valid_to: null,
        conflict_status: 'none',
      },
    ];
    expect(contested(rows).map((row) => row.id)).toEqual([1]);
  });
});

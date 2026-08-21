import { describe, expect, it } from 'vitest';
import {
  decodeView,
  encodeView,
  isBlocked,
  KANBAN_COLUMNS,
  needsHuman,
  OVERFLOW_LANE,
  projectBoard,
  SWIMLANE_CAP,
  unplaceable,
  type BoardCard,
} from './index.js';

/**
 * P3-KAN-01 — the board projection.
 *
 * A board is a claim about the state of work. These assert the claims that are
 * easy to get wrong and invisible when wrong: a stale claim is blocked, an
 * unknown stage is reported rather than dropped, and a capped grouping names
 * its overflow instead of hiding work.
 */

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: 'FEAT-1',
  title: 'a card',
  type: 'feature',
  lifecycle_state: 'implement',
  ...over,
});

const NOW = new Date('2026-08-22T12:00:00Z');

describe('isBlocked', () => {
  it('is blocked by a failing gate', () => {
    expect(isBlocked(card({ gate_state: 'fail' }), NOW)).toBe(true);
    expect(isBlocked(card({ gate_state: 'pass' }), NOW)).toBe(false);
    expect(isBlocked(card({ gate_state: 'pending' }), NOW)).toBe(false);
  });

  it('is blocked by a claim whose lease has expired', () => {
    // The quietest way for work to stop moving: nothing failed, nothing is red,
    // the card is held by an agent that is no longer running, and it is not
    // available to anyone else either.
    expect(
      isBlocked(card({ claimed_by: 'agent-1', lease_expires_at: '2026-08-22T11:00:00Z' }), NOW),
    ).toBe(true);
  });

  it('is not blocked by a live lease', () => {
    expect(
      isBlocked(card({ claimed_by: 'agent-1', lease_expires_at: '2026-08-22T13:00:00Z' }), NOW),
    ).toBe(false);
  });

  it('is not blocked by an expiry on a card nobody holds', () => {
    // A stale timestamp left behind by a released claim is not a block.
    expect(
      isBlocked(card({ claimed_by: null, lease_expires_at: '2020-01-01T00:00:00Z' }), NOW),
    ).toBe(false);
  });

  it('treats an unparseable lease as not blocked, rather than guessing', () => {
    expect(isBlocked(card({ claimed_by: 'a', lease_expires_at: 'not a date' }), NOW)).toBe(false);
  });
});

describe('needsHuman', () => {
  it('is true at the stages only a person may move', () => {
    expect(needsHuman(card({ lifecycle_state: 'approval' }))).toBe(true);
    expect(needsHuman(card({ lifecycle_state: 'review' }))).toBe(true);
  });

  it('is false where an agent may act', () => {
    expect(needsHuman(card({ lifecycle_state: 'implement' }))).toBe(false);
  });
});

describe('projectBoard', () => {
  it('keeps every column, including the empty ones', () => {
    // A column that vanishes when it empties changes the board's shape under
    // the user and hides where work should go next.
    const board = projectBoard([card({ lifecycle_state: 'implement' })]);
    expect(board.columns.map((column) => column.column)).toEqual([...KANBAN_COLUMNS]);
    expect(board.columns.find((column) => column.column === 'Done')?.total).toBe(0);
  });

  it('places cards in the column their stage projects to', () => {
    const board = projectBoard([
      card({ id: 'A', lifecycle_state: 'intake' }),
      card({ id: 'B', lifecycle_state: 'implement' }),
      card({ id: 'C', lifecycle_state: 'test' }),
    ]);
    const inProgress = board.columns.find((column) => column.column === 'In Progress');
    expect(inProgress?.total).toBe(2);
    expect(board.columns.find((column) => column.column === 'Backlog')?.total).toBe(1);
  });

  it('counts what a filter hid, so a filtered board never looks empty by accident', () => {
    const board = projectBoard(
      [card({ id: 'A', title: 'auth' }), card({ id: 'B', title: 'parser' })],
      { filter: { text: 'auth' } },
    );
    expect(board.hidden).toBe(1);
  });

  it('filters to blocked cards only', () => {
    const board = projectBoard(
      [card({ id: 'A', gate_state: 'fail' }), card({ id: 'B', gate_state: 'pass' })],
      { filter: { blockedOnly: true }, now: NOW },
    );
    const ids = board.columns.flatMap((column) =>
      column.lanes.flatMap((lane) => lane.cards.map((c) => c.id)),
    );
    expect(ids).toEqual(['A']);
  });

  it('groups into swimlanes and orders them the same way in every column', () => {
    // Lane order is decided once across the board. Per-column ordering would
    // put the same person's lane in a different row in each column, which makes
    // the grouping unreadable.
    const cards = [
      card({ id: 'A', claimed_by: 'ada', lifecycle_state: 'implement' }),
      card({ id: 'B', claimed_by: 'ada', lifecycle_state: 'intake' }),
      card({ id: 'C', claimed_by: 'bob', lifecycle_state: 'implement' }),
    ];
    const board = projectBoard(cards, { groupBy: 'assignee' });
    const order = (name: string): string[] =>
      board.columns.find((column) => column.column === name)?.lanes.map((lane) => lane.key) ?? [];
    expect(order('In Progress')).toEqual(order('Backlog'));
    expect(order('In Progress')[0]).toBe('ada');
  });

  it('names and counts the overflow rather than dropping it', () => {
    // A board that silently hides work is worse than no grouping at all.
    const cards = Array.from({ length: SWIMLANE_CAP + 3 }, (_, index) =>
      card({ id: `C${String(index)}`, claimed_by: `person-${String(index)}` }),
    );
    const board = projectBoard(cards, { groupBy: 'assignee' });
    expect(board.collapsedLanes).toHaveLength(3);

    const column = board.columns.find((entry) => entry.column === 'In Progress');
    const overflow = column?.lanes.find((lane) => lane.key === OVERFLOW_LANE);
    expect(overflow?.isOverflow).toBe(true);
    expect(overflow?.cards).toHaveLength(3);

    // Nothing is lost: every card is still somewhere on the board.
    const placed = board.columns.flatMap((entry) => entry.lanes.flatMap((lane) => lane.cards));
    expect(placed).toHaveLength(cards.length);
  });

  it('has no overflow lane when nothing overflowed', () => {
    const board = projectBoard([card({ claimed_by: 'ada' })], { groupBy: 'assignee' });
    const lanes = board.columns.flatMap((column) => column.lanes.map((lane) => lane.key));
    expect(lanes).not.toContain(OVERFLOW_LANE);
  });

  it('gives ungrouped cards an honest bucket name rather than an empty one', () => {
    const board = projectBoard([card({ parent_id: null })], { groupBy: 'epic' });
    expect(board.columns.flatMap((column) => column.lanes.map((lane) => lane.label))).toContain(
      '(no epic)',
    );
  });

  it('does not place a card whose stage it does not know', () => {
    const board = projectBoard([card({ id: 'GHOST', lifecycle_state: 'from_the_future' })]);
    const placed = board.columns.flatMap((column) => column.lanes.flatMap((lane) => lane.cards));
    expect(placed).toHaveLength(0);
  });
});

describe('unplaceable', () => {
  it('reports a card the board cannot place, rather than losing it', () => {
    // An unknown stage means the database and this build disagree — usually a
    // newer workspace against an older CLI — and a card that silently vanishes
    // is the worst possible way to find that out.
    const ghost = card({ id: 'GHOST', lifecycle_state: 'from_the_future' });
    expect(unplaceable([card(), ghost]).map((entry) => entry.id)).toEqual(['GHOST']);
  });

  it('is empty when every stage is known', () => {
    expect(unplaceable([card()])).toEqual([]);
  });
});

describe('saved views', () => {
  it('round-trips through a URL query', () => {
    // A URL rather than local storage, so "the board I am looking at" can be
    // pasted to somebody else. A view that exists in one browser cannot be
    // discussed.
    const view = {
      name: 'blocked work',
      groupBy: 'risk' as const,
      filter: { text: 'auth', risk: 'high', blockedOnly: true, needsHumanOnly: false },
    };
    const decoded = decodeView(encodeView(view));
    expect(decoded.name).toBe(view.name);
    expect(decoded.groupBy).toBe('risk');
    expect(decoded.filter.text).toBe('auth');
    expect(decoded.filter.risk).toBe('high');
    expect(decoded.filter.blockedOnly).toBe(true);
    expect(decoded.filter.needsHumanOnly).toBe(false);
  });

  it('omits defaults, so a plain board has a clean URL', () => {
    const encoded = encodeView({ name: 'board', groupBy: 'none', filter: {} });
    expect(encoded).toBe('view=board');
  });

  it('falls back to no grouping for a group it does not recognise', () => {
    // A hand-edited or stale URL must not produce a board grouped by nothing
    // meaningful and silently empty.
    expect(decodeView('group=by-astrology').groupBy).toBe('none');
  });

  it('decodes an empty query into a usable default', () => {
    const view = decodeView('');
    expect(view.groupBy).toBe('none');
    expect(view.filter.blockedOnly).toBe(false);
  });
});

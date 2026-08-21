// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '@sdlc-on-fire/core/browser';
import { BoardView } from './BoardView.js';
import { useUiStore } from '../state/ui.js';

/**
 * P3-KAN-01 — the board, rendered.
 *
 * The projection is tested in core. What is worth asserting here is what only
 * exists once it is on screen: that every column is present even when empty,
 * that a card the board cannot place is named rather than dropped, and that a
 * card is reachable by keyboard at all.
 */

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  id: 'FEAT-1',
  title: 'a card',
  type: 'feature',
  lifecycle_state: 'implement',
  ...over,
});

const NO_FILTER = { text: '', risk: null, blockedOnly: false, needsHumanOnly: false };

function renderBoard(cards: BoardCard[], overrides: Partial<Parameters<typeof BoardView>[0]> = {}) {
  const onMove = vi.fn();
  const onClearFilters = vi.fn();
  render(
    <BoardView
      cards={cards}
      groupBy="none"
      filter={NO_FILTER}
      onMove={onMove}
      onClearFilters={onClearFilters}
      {...overrides}
    />,
  );
  return { onMove, onClearFilters };
}

afterEach(cleanup);

describe('BoardView', () => {
  it('shows every column, including the empty ones', () => {
    // A column that vanishes when it empties hides where work should go next.
    renderBoard([card()]);
    for (const column of [
      'Backlog',
      'Discovery',
      'Spec',
      'Plan',
      'In Progress',
      'Review',
      'Done',
    ]) {
      expect(screen.getByRole('region', { name: new RegExp(`^${column},`) }), column).toBeDefined();
    }
  });

  it('counts the cards in each column heading', () => {
    renderBoard([card({ id: 'A' }), card({ id: 'B' })]);
    expect(screen.getByRole('region', { name: /^In Progress, 2 cards/ })).toBeDefined();
  });

  it('names a card it cannot place instead of dropping it', () => {
    // An unknown stage means the workspace and this build disagree. A card
    // that silently disappears is the worst way to discover that.
    renderBoard([card({ id: 'GHOST', lifecycle_state: 'from_the_future' })]);
    // Queried by content, not by role: dnd-kit renders its own `role="status"`
    // live region for drag announcements, so `getByRole('status')` matches two
    // elements and the assertion becomes about whichever came first.
    expect(screen.getByText(/does not know/i).textContent).toContain('GHOST');
  });

  it('says nothing about unplaceable cards when there are none', () => {
    renderBoard([card()]);
    expect(screen.queryByText(/does not know/i)).toBeNull();
  });

  it('makes every card reachable and labelled for a keyboard', () => {
    // Dragging is the board's primary verb. A primary verb available only to a
    // mouse is a board a keyboard user cannot operate at all.
    renderBoard([card({ id: 'FEAT-7', title: 'Add auth' })]);
    const item = screen.getByRole('button', { name: 'FEAT-7: Add auth' });
    expect(item.getAttribute('tabindex')).toBe('0');
    expect(item.getAttribute('aria-roledescription')).toBe('draggable card');
  });

  it('opens the drawer on a plain click instead of starting a drag', async () => {
    // The defect this closes, found by clicking the running board. Without a
    // distance constraint the pointer sensor claims mousedown anywhere in the
    // card — including the nested button — so a click started a drag and
    // immediately dropped it back, showing "already in that column" instead of
    // opening the card.
    useUiStore.setState({ selectedId: null });
    renderBoard([card({ id: 'FEAT-7' })]);

    await userEvent.click(screen.getByRole('button', { name: /open details for FEAT-7/i }));
    expect(useUiStore.getState().selectedId).toBe('FEAT-7');
  });

  it('offers a way out when a filter hides everything', async () => {
    // The board's projection applies the filter, so it is the only thing that
    // knows the result is empty — the shell sees a non-empty card list and
    // would render seven empty columns with no explanation.
    const { onClearFilters } = renderBoard([card({ title: 'auth' })], {
      filter: { ...NO_FILTER, text: 'nothing matches' },
    });
    await userEvent.click(screen.getByRole('button', { name: /clear it/i }));
    expect(onClearFilters).toHaveBeenCalled();
  });

  it('reports how many are hidden when some still show', () => {
    renderBoard([card({ id: 'A', title: 'auth' }), card({ id: 'B', title: 'parser' })], {
      filter: { ...NO_FILTER, text: 'auth' },
    });
    expect(screen.getByText(/1 card\(s\) hidden/)).toBeDefined();
  });

  it('distinguishes an ungated card from a passing one', () => {
    // A card nothing has checked has not passed anything. Rendering both as
    // "pass" is the exact claim this product exists to refuse.
    renderBoard([card({ id: 'A', gate_state: null }), card({ id: 'B', gate_state: 'pass' })]);
    expect(screen.getByText('ungated')).toBeDefined();
    expect(screen.getByText('gate pass')).toBeDefined();
  });

  it('marks a blocked card and a card waiting on a person', () => {
    renderBoard([
      card({ id: 'A', gate_state: 'fail' }),
      card({ id: 'B', lifecycle_state: 'approval' }),
    ]);
    expect(screen.getByText('blocked')).toBeDefined();
    expect(screen.getByText('needs a human')).toBeDefined();
  });

  it('shows a live run chip only while something is running', () => {
    renderBoard([card({ id: 'A', active_run: 'run-1' }), card({ id: 'B', active_run: null })]);
    expect(screen.getAllByText('running')).toHaveLength(1);
  });
});

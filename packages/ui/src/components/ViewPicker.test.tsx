// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewDefinition } from '@sdlc-on-fire/core/browser';
import { ViewPicker } from './ViewPicker.js';
import { EMPTY_FILTERS, useUiStore } from '../state/ui.js';

/**
 * P4-COLLAB-03 — applying a saved view.
 *
 * The parsing and role scoping are tested in core. What only exists once this
 * is on screen is that applying a view leaves the board *editable* — a view is
 * a starting point people then narrow, and a picker that locked the controls
 * would break the thing saved views are for.
 */

const view = (over: Partial<ViewDefinition> = {}): ViewDefinition => ({
  slug: 'sec',
  name: 'Security blockers',
  mode: 'table',
  groupBy: 'risk',
  filter: { blockedOnly: true },
  role: 'security',
  description: null,
  ...over,
});

beforeEach(() => {
  useUiStore.setState({ view: 'board', filters: EMPTY_FILTERS });
});
afterEach(cleanup);

describe('ViewPicker', () => {
  it('renders nothing when a project has no saved views', () => {
    // A control offering no choices reads as broken; absent reads as "none".
    const { container } = render(<ViewPicker views={[]} onGroupBy={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('applies mode, grouping and filters together', async () => {
    const onGroupBy = vi.fn();
    render(<ViewPicker views={[view()]} onGroupBy={onGroupBy} />);
    await userEvent.selectOptions(screen.getByLabelText(/apply a saved view/i), 'sec');

    expect(useUiStore.getState().view).toBe('table');
    expect(useUiStore.getState().filters.blockedOnly).toBe(true);
    expect(onGroupBy).toHaveBeenCalledWith('risk');
  });

  it('resets filters the view does not mention rather than inheriting them', async () => {
    // Merging into whatever was there makes the board you get depend on the
    // board you came from — the same view producing two different results.
    useUiStore.setState({ filters: { ...EMPTY_FILTERS, text: 'leftover', needsHumanOnly: true } });
    render(<ViewPicker views={[view()]} onGroupBy={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/apply a saved view/i), 'sec');

    expect(useUiStore.getState().filters.text).toBe('');
    expect(useUiStore.getState().filters.needsHumanOnly).toBe(false);
    expect(useUiStore.getState().filters.blockedOnly).toBe(true);
  });

  it('leaves the board editable after applying', async () => {
    render(<ViewPicker views={[view()]} onGroupBy={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText(/apply a saved view/i), 'sec');
    // The control returns to "—" rather than latching, because once applied the
    // state is ordinary board state the user may immediately change.
    expect(screen.getByLabelText(/apply a saved view/i).getAttribute('value')).not.toBe('sec');
  });

  it('names the role a view is scoped to', () => {
    render(<ViewPicker views={[view()]} onGroupBy={vi.fn()} />);
    expect(screen.getByRole('option', { name: /Security blockers \(security\)/ })).toBeDefined();
  });

  it('does not annotate an unscoped view with a role', () => {
    render(<ViewPicker views={[view({ role: null, name: 'Everything' })]} onGroupBy={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Everything' })).toBeDefined();
  });

  it('ignores a selection that matches no view', async () => {
    const onGroupBy = vi.fn();
    render(<ViewPicker views={[view()]} onGroupBy={onGroupBy} />);
    await userEvent.selectOptions(screen.getByLabelText(/apply a saved view/i), '');
    expect(onGroupBy).not.toHaveBeenCalled();
    expect(useUiStore.getState().view).toBe('board');
  });
});

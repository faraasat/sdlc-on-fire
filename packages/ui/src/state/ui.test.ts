import { beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILTERS, isFiltered, useUiStore } from './ui.js';

/**
 * P3-UI-01 — UI state, and the half of ADR-0016's firewall this side owns.
 *
 * Everything here is ephemeral and local. The test that matters most is not any
 * single behaviour but the structural one at the bottom: nothing in this store
 * is sent anywhere, so a value a human typed into a browser cannot reach an
 * agent without first being written through the daemon.
 */

beforeEach(() => {
  useUiStore.setState({
    view: 'board',
    selectedId: null,
    filters: EMPTY_FILTERS,
    connection: 'connecting',
  });
});

describe('useUiStore', () => {
  it('switches view and selection', () => {
    useUiStore.getState().setView('table');
    useUiStore.getState().select('FEAT-1');
    expect(useUiStore.getState().view).toBe('table');
    expect(useUiStore.getState().selectedId).toBe('FEAT-1');
  });

  it('patches filters without dropping the others', () => {
    useUiStore.getState().setFilters({ text: 'auth' });
    useUiStore.getState().setFilters({ blockedOnly: true });
    expect(useUiStore.getState().filters).toEqual({
      ...EMPTY_FILTERS,
      text: 'auth',
      blockedOnly: true,
    });
  });

  it('clears every filter at once', () => {
    useUiStore.getState().setFilters({ text: 'x', risk: 'high', needsHumanOnly: true });
    useUiStore.getState().clearFilters();
    expect(useUiStore.getState().filters).toEqual(EMPTY_FILTERS);
  });

  it('tracks connection status, because a stale board must never look current', () => {
    useUiStore.getState().setConnection('reconnecting');
    expect(useUiStore.getState().connection).toBe('reconnecting');
  });

  it('holds nothing that could be sent to the daemon', () => {
    // The firewall, asserted structurally. If a future change adds a field here
    // that a human authors and something persists, this is where it should be
    // noticed — the store's whole surface is view, selection, filters and
    // connection, none of which are content.
    useUiStore.getState().setFilters({ text: 'a secret note a human typed' });
    const keys = Object.keys(useUiStore.getState()).filter(
      (key) => typeof (useUiStore.getState() as Record<string, unknown>)[key] !== 'function',
    );
    expect(keys.sort()).toEqual(['connection', 'filters', 'selectedId', 'view']);
  });
});

describe('isFiltered', () => {
  it('is false for a pristine board', () => {
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
  });

  it('does not count whitespace as a filter', () => {
    // Otherwise clicking into the search box and pressing space would tell the
    // user their board is a subset when it is not.
    expect(isFiltered({ ...EMPTY_FILTERS, text: '   ' })).toBe(false);
  });

  it('notices each filter kind', () => {
    expect(isFiltered({ ...EMPTY_FILTERS, text: 'a' })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, risk: 'high' })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, blockedOnly: true })).toBe(true);
    expect(isFiltered({ ...EMPTY_FILTERS, needsHumanOnly: true })).toBe(true);
  });
});

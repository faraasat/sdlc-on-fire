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
    theme: 'ember',
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

  it('drops presence the moment the connection stops being live', () => {
    // A viewer list rendered over a dead socket is the exact failure presence
    // exists to avoid: it keeps showing people who left, and it looks identical
    // to a current one. An empty list is visibly empty; a frozen one is not.
    useUiStore.getState().setConnection('live');
    useUiStore.getState().setViewers([
      {
        key: 'ana',
        actorId: 'ana',
        displayName: 'Ana',
        cardIds: [],
        seenAt: 1_000,
        connections: 1,
      },
    ]);
    expect(useUiStore.getState().viewers).toHaveLength(1);

    useUiStore.getState().setConnection('reconnecting');
    expect(useUiStore.getState().viewers).toEqual([]);
  });

  it('keeps presence while the connection stays live', () => {
    useUiStore.getState().setViewers([
      {
        key: 'bo',
        actorId: 'bo',
        displayName: 'Bo',
        cardIds: ['A'],
        seenAt: 2_000,
        connections: 2,
      },
    ]);
    useUiStore.getState().setConnection('live');
    expect(useUiStore.getState().viewers).toHaveLength(1);
  });

  it('holds nothing that could be sent to the daemon', () => {
    // The firewall, asserted structurally. If a future change adds a field here
    // that a human authors and something persists, this is where it should be
    // noticed — the store's whole surface is view, selection, filters and
    // connection, none of which are content.
    // A theme is a rendering preference, not content — it belongs on this side
    // of the firewall for the same reason a filter does.
    // `viewers` is inbound: it arrives over the socket from the daemon and is
    // never authored here, so holding it cannot leak anything to an agent that
    // the daemon did not already know. Adding it to this list is a decision,
    // not a formality — anything appearing here that a *human types* is the
    // failure this assertion exists to catch, and should move rather than be
    // appended.
    useUiStore.getState().setFilters({ text: 'a secret note a human typed' });
    const keys = Object.keys(useUiStore.getState()).filter(
      (key) =>
        typeof (useUiStore.getState() as unknown as Record<string, unknown>)[key] !== 'function',
    );
    expect(keys.sort()).toEqual([
      'connection',
      'filters',
      'selectedId',
      'theme',
      'view',
      'viewers',
    ]);
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

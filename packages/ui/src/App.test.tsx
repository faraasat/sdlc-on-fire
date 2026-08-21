// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { EMPTY_FILTERS, useUiStore } from './state/ui.js';

/**
 * P3-UI-01 — the shell, rendered.
 *
 * The distinctions under test are the ones a user acts on and a snapshot would
 * flatten: an empty board is not a filtered-empty board, a solo-mode identity
 * is not an identified one, and a reconnecting socket is not a live one. Each
 * of those pairs looks similar and asks for opposite responses.
 */

const items = [
  {
    id: 'FEAT-1',
    type: 'feature',
    title: 'Add auth',
    status: 'inbox',
    lifecycle_state: 'spec',
    risk_level: 'high',
    parent_id: null,
    claimed_by: null,
    claim_kind: null,
    lease_expires_at: null,
    updated_at: '2026-08-22T00:00:00Z',
  },
  {
    id: 'BUG-2',
    type: 'bug',
    title: 'Fix the parser',
    status: 'inbox',
    lifecycle_state: 'build',
    risk_level: 'low',
    parent_id: null,
    claimed_by: null,
    claim_kind: null,
    lease_expires_at: null,
    updated_at: '2026-08-22T00:00:00Z',
  },
];

const soloIdentity = {
  actor: { id: 'a1', kind: 'human', displayName: 'Solo', email: null },
  ground: 'solo-implicit',
  because: 'exactly one human actor exists',
  attributable: false,
};

function mockApi(overrides: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = String(input);
      const body =
        url in overrides
          ? overrides[url]
          : url.includes('/api/identity')
            ? soloIdentity
            : url.includes('/api/work-items')
              ? items
              : [];
      if (body === 'ERROR') {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'daemon is not running' }), { status: 503 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

// The shell opens a socket on mount; a stub keeps these tests about rendering.
class SilentSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send(): void {}
  close(): void {}
}

function renderApp(): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
  return <></>;
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', SilentSocket);
  useUiStore.setState({
    view: 'board',
    selectedId: null,
    filters: EMPTY_FILTERS,
    connection: 'live',
  });
  mockApi();
});

afterEach(() => {
  // Explicit, because Testing Library only auto-registers cleanup when Vitest
  // globals are on and they are not here. Without it every render stacks and
  // the second test fails with "found multiple elements" — a failure that
  // looks like a component bug and is a harness one.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('renders the work items the daemon returned', async () => {
    renderApp();
    expect(await screen.findByText('Add auth')).toBeDefined();
    expect(screen.getByText('Fix the parser')).toBeDefined();
  });

  it('says the board is empty differently from the filter hiding everything', async () => {
    // These ask for opposite next actions: write a card, or clear the filter.
    // Rendering one message for both is the kind of small wrong that makes a
    // tool feel broken.
    renderApp();
    await screen.findByText('Add auth');

    await userEvent.type(screen.getByLabelText('filter work items'), 'nothing matches this');
    await waitFor(() => {
      expect(screen.getByText(/nothing matches this filter/i)).toBeDefined();
    });
    expect(screen.queryByText(/no work items yet/i)).toBeNull();
  });

  it('offers a way out of a filter that hides everything', async () => {
    renderApp();
    await screen.findByText('Add auth');
    await userEvent.type(screen.getByLabelText('filter work items'), 'zzzz');
    await waitFor(() => expect(screen.getByText(/nothing matches this filter/i)).toBeDefined());

    await userEvent.click(screen.getByRole('button', { name: /clear it/i }));
    expect(await screen.findByText('Add auth')).toBeDefined();
  });

  it('reports a truly empty board as empty, not as filtered', async () => {
    mockApi({ '/api/work-items': [] });
    renderApp();
    expect(await screen.findByText(/no work items yet/i)).toBeDefined();
  });

  it('filters by id as well as title', async () => {
    renderApp();
    await screen.findByText('Add auth');
    await userEvent.type(screen.getByLabelText('filter work items'), 'BUG-2');
    await waitFor(() => expect(screen.queryByText('Add auth')).toBeNull());
    expect(screen.getByText('Fix the parser')).toBeDefined();
  });

  it('shows a solo-mode identity as unable to approve', async () => {
    // Shown before the user reaches for a button that needs it, rather than
    // after. Solo mode is an inference about an empty room.
    renderApp();
    expect(await screen.findByText('Solo')).toBeDefined();
    expect(screen.getByText(/cannot approve/i)).toBeDefined();
  });

  it('does not claim solo mode when identity is attributable', async () => {
    mockApi({
      '/api/identity': { ...soloIdentity, ground: 'git-email', attributable: true },
    });
    renderApp();
    expect(await screen.findByText('Solo')).toBeDefined();
    expect(screen.queryByText(/cannot approve/i)).toBeNull();
  });

  it('surfaces a daemon that is not running, rather than an empty board', async () => {
    // An unreachable daemon and an empty project render identically unless
    // this is explicit, and the first needs a fix while the second needs a card.
    mockApi({ '/api/work-items': 'ERROR' });
    renderApp();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('daemon is not running');
  });

  it('always shows whether the board is live', async () => {
    renderApp();
    // Set after mount, not before: `useRealtime` puts the store into
    // `connecting` as it opens the socket, so a status seeded in `beforeEach`
    // is overwritten before the first paint. Asserting the seeded value tested
    // the fixture rather than the component.
    await screen.findByText('Add auth');

    useUiStore.getState().setConnection('live');
    await waitFor(() => expect(screen.getByTitle('live')).toBeDefined());

    useUiStore.getState().setConnection('reconnecting');
    await waitFor(() => {
      expect(screen.getByTitle(/this view may be behind/i)).toBeDefined();
    });
  });

  it('starts as connecting rather than claiming to be live', async () => {
    // The default must be the cautious one. A board that says "live" before the
    // socket has opened is making exactly the claim this product refuses.
    renderApp();
    expect(await screen.findByTitle(/connecting/i)).toBeDefined();
  });

  it('switches view and marks the active one for assistive tech', async () => {
    renderApp();
    const table = screen.getByRole('button', { name: 'table' });
    expect(table.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(table);
    expect(table.getAttribute('aria-pressed')).toBe('true');
  });
});

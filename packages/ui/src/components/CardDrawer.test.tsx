// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDrawer } from './CardDrawer.js';

/**
 * P3-KAN-02 — the drawer.
 *
 * The assertions worth having are the distinctions a screenshot would flatten:
 * ungated is not passing, a skipped stage is not a completed one, and a
 * keyboard user can both reach the panel and leave it.
 */

const detail = {
  item: {
    id: 'FEAT-1',
    title: 'Add auth',
    lifecycle_state: 'implement',
    preset: 'standard',
    work_type: 'feature',
  },
  gates: [] as Record<string, unknown>[],
  runs: [] as Record<string, unknown>[],
  comments: [] as Record<string, unknown>[],
  transitions: [{ to_state: 'spec' }, { to_state: 'implement' }] as Record<string, unknown>[],
};

function stub(body: unknown = detail): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))),
  );
}

function renderDrawer(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CardDrawer cardId="FEAT-1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => stub());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CardDrawer', () => {
  it('shows the card', async () => {
    renderDrawer();
    expect(await screen.findByText('Add auth')).toBeDefined();
  });

  it('says no gate has run, rather than showing a pass', async () => {
    // A card nothing has checked has not passed anything.
    renderDrawer();
    expect(await screen.findByText(/no gate has run/i)).toBeDefined();
  });

  it('renders a comment by its computed effect, not its body', async () => {
    // `role_effect` is computed server-side at insert and never re-derived
    // (ADR-0012); it is the thing that actually acted, so it is what is shown.
    stub({
      ...detail,
      comments: [{ type: 'blocker', body: 'this is wrong', role_effect: 'GATE_BLOCK' }],
    });
    renderDrawer();
    expect(await screen.findByText('GATE_BLOCK')).toBeDefined();
    expect(screen.getByText('this is wrong')).toBeDefined();
  });

  it('does not label an effect-free comment', async () => {
    stub({ ...detail, comments: [{ type: 'normal', body: 'just a note', role_effect: 'NONE' }] });
    renderDrawer();
    await screen.findByText('just a note');
    expect(screen.queryByText('NONE')).toBeNull();
  });

  it('shows progress dots labelled for assistive tech', async () => {
    renderDrawer();
    const dots = await screen.findByRole('list', { name: /stages complete/i });
    expect(dots).toBeDefined();
  });

  it('marks a jumped-over required stage as skipped rather than done', async () => {
    // Rendering it as done would hide the one thing worth knowing about the card.
    stub({
      ...detail,
      item: { ...detail.item, lifecycle_state: 'implement' },
      transitions: [{ to_state: 'implement' }],
    });
    renderDrawer();
    await screen.findByText('Add auth');
    expect(screen.getAllByTitle(/required, and jumped over/i).length).toBeGreaterThan(0);
  });

  it('takes focus when it opens, so a keyboard user can reach it', async () => {
    renderDrawer();
    const close = await screen.findByRole('button', { name: /close card details/i });
    await waitFor(() => expect(document.activeElement).toBe(close));
  });

  it('closes on Escape as well as on the button', async () => {
    // A panel a keyboard user can enter and not leave is a trap.
    const onClose = renderDrawer();
    await screen.findByRole('button', { name: /close card details/i });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('is announced as a dialog', async () => {
    renderDrawer();
    expect(await screen.findByRole('dialog', { name: /FEAT-1/ })).toBeDefined();
  });

  it('never renders an object as [object Object]', async () => {
    // The kind of defect that survives review because it only appears for the
    // one column somebody later changes to JSON.
    stub({
      ...detail,
      comments: [{ type: 'normal', body: { nested: 'value' }, role_effect: 'NONE' }],
      runs: [{ id: 'r1', status: 'pass', model: { name: 'opus' } }],
    });
    renderDrawer();
    await screen.findByText('Add auth');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('surfaces a failed load instead of an empty panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'gone' }), { status: 404 })),
      ),
    );
    renderDrawer();
    expect((await screen.findByRole('alert')).textContent).toContain('gone');
  });
});

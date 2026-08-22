// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '@sdlc-on-fire/core/browser';
import { ActivityFeed, ago } from './ActivityFeed.js';

/**
 * P4-COLLAB-01 — the feed, rendered.
 *
 * The merge and the severity mapping are tested in core. What only exists once
 * this is on screen is whether a blocking entry is distinguishable, whether an
 * agent is marked as one, and whether colour is doing work no word backs up.
 */

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  kind: 'comment',
  at: '2026-08-22T11:00:00.000Z',
  cardId: 'P4-COLLAB-01',
  actor: 'Ana',
  actorKind: 'human',
  summary: 'looks fine',
  severity: 'normal',
  ...over,
});

afterEach(cleanup);

describe('ago', () => {
  it('reads coarsely rather than to the second', () => {
    expect(ago('2026-08-22T11:59:30.000Z', NOW)).toBe('just now');
    expect(ago('2026-08-22T11:45:00.000Z', NOW)).toBe('15m ago');
    expect(ago('2026-08-22T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(ago('2026-08-19T12:00:00.000Z', NOW)).toBe('3d ago');
  });

  it('reads a clock skewed ahead as "just now" rather than a negative age', () => {
    // The daemon's clock and the browser's need not agree. "in -2m" is a bug
    // report; "just now" is the honest reading of a little skew.
    expect(ago('2026-08-22T12:02:00.000Z', NOW)).toBe('just now');
  });

  it('returns nothing for an unparseable timestamp instead of NaN', () => {
    expect(ago('not a date', NOW)).toBe('');
  });
});

describe('ActivityFeed', () => {
  it('says so when nothing has happened', () => {
    render(<ActivityFeed entries={[]} nowMs={NOW} />);
    expect(screen.getByText(/nothing has happened/i)).toBeDefined();
  });

  it('marks a blocking entry with a word, not only a colour', () => {
    // A red border alone fails anyone who cannot distinguish it. The same rule
    // the risk chips follow.
    render(
      <ActivityFeed
        entries={[entry({ severity: 'blocking', effect: 'GATE_BLOCK' })]}
        nowMs={NOW}
      />,
    );
    expect(screen.getByText('blocking')).toBeDefined();
  });

  it('renders the severity it was given rather than deriving one from the type', () => {
    // ADR-0012. A `normal`-typed comment whose stored effect is GATE_BLOCK is
    // blocking, and a component that looked at the type would call it quiet.
    const { container } = render(
      <ActivityFeed
        entries={[entry({ kind: 'comment', severity: 'blocking', effect: 'GATE_BLOCK' })]}
        nowMs={NOW}
      />,
    );
    expect(container.querySelector('.feed__row--blocking')).not.toBeNull();
  });

  it('marks an agent as an agent', () => {
    render(
      <ActivityFeed entries={[entry({ actor: 'implementer', actorKind: 'agent' })]} nowMs={NOW} />,
    );
    expect(screen.getByTitle(/agent, not a person/i)).toBeDefined();
  });

  it('does not mark a human as an agent', () => {
    render(<ActivityFeed entries={[entry({ actorKind: 'human' })]} nowMs={NOW} />);
    expect(screen.queryByTitle(/agent, not a person/i)).toBeNull();
  });

  it('renders an unattributed entry rather than dropping it', () => {
    render(<ActivityFeed entries={[entry({ actor: null, actorKind: null })]} nowMs={NOW} />);
    expect(screen.getByText('looks fine')).toBeDefined();
  });

  it('gives two events that share a timestamp, card and kind distinct keys', () => {
    // A key built only from those three collides. React still renders both, so
    // a count assertion passes while the list is primed to reconcile wrongly on
    // the next update — the warning is the only signal available at this point.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ActivityFeed
        entries={[entry({ summary: 'first' }), entry({ summary: 'second' })]}
        nowMs={NOW}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(spy.mock.calls.some((call) => call.join(' ').includes('same key'))).toBe(false);
    spy.mockRestore();
  });

  it('shows the card only when asked, so a per-card drawer is not repetitive', () => {
    const { rerender } = render(<ActivityFeed entries={[entry()]} nowMs={NOW} />);
    expect(screen.queryByText('P4-COLLAB-01')).toBeNull();
    rerender(<ActivityFeed entries={[entry()]} nowMs={NOW} showCard />);
    expect(screen.getByText('P4-COLLAB-01')).toBeDefined();
  });
});

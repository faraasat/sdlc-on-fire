// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Viewer } from '@sdlc-on-fire/core/browser';
import { PresenceBar, initials, others } from './PresenceBar.js';

/**
 * P4-COLLAB-01 — presence, on screen.
 *
 * The daemon has broadcast presence since P3-RT-02 and nothing rendered it. The
 * assertions worth making here are the ones that only exist once it is visible:
 * that it disappears rather than reading "0 others", that you are not shown to
 * yourself, and that a name reaches a screen reader when the avatar is initials.
 */

const viewer = (over: Partial<Viewer> = {}): Viewer => ({
  key: 'ana',
  actorId: 'ana',
  displayName: 'Ana Ruiz',
  cardIds: [],
  seenAt: 1_000,
  connections: 1,
  ...over,
});

afterEach(cleanup);

describe('initials', () => {
  it('takes first and last for a full name', () => {
    expect(initials('Ana Ruiz')).toBe('AR');
  });

  it('takes one letter for a single word', () => {
    // "IM" would read as a two-word name that does not exist.
    expect(initials('implementer')).toBe('I');
  });

  it('skips the middle of a longer name', () => {
    expect(initials('Ana Maria Ruiz')).toBe('AR');
  });

  it('survives an empty or blank name rather than rendering nothing', () => {
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('others', () => {
  it('removes you from the list', () => {
    const list = [viewer({ key: 'ana', actorId: 'ana' }), viewer({ key: 'bo', actorId: 'bo' })];
    expect(others(list, 'ana').map((v) => v.actorId)).toEqual(['bo']);
  });

  it('keeps everyone when you are unidentified', () => {
    // An unattributable session must not silently filter a real person out by
    // matching null against null.
    const list = [viewer({ actorId: null, key: 'c1' })];
    expect(others(list, null)).toHaveLength(1);
  });
});

describe('PresenceBar', () => {
  it('renders nothing when nobody else is here', () => {
    // "0 others" is noise where empty space is not.
    const { container } = render(<PresenceBar viewers={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the only viewer is you', () => {
    const { container } = render(<PresenceBar viewers={[viewer()]} selfActorId="ana" />);
    expect(container.innerHTML).toBe('');
  });

  it('gives a screen reader the name, not the initials', () => {
    render(<PresenceBar viewers={[viewer()]} />);
    expect(screen.getByLabelText('Ana Ruiz').textContent).toBe('AR');
  });

  it('names the card someone is on', () => {
    render(<PresenceBar viewers={[viewer({ cardIds: ['P4-COLLAB-01'] })]} />);
    expect(screen.getByLabelText('Ana Ruiz').getAttribute('title')).toBe('Ana Ruiz — P4-COLLAB-01');
  });

  it('collapses past the cap rather than growing without bound', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      viewer({ key: `k${String(i)}`, actorId: `a${String(i)}`, displayName: `P${String(i)} X` }),
    );
    render(<PresenceBar viewers={many} max={5} />);
    expect(screen.getByLabelText('3 more').textContent).toBe('+3');
  });

  it('shows no overflow marker when everyone fits', () => {
    render(<PresenceBar viewers={[viewer()]} max={5} />);
    expect(screen.queryByText(/^\+/)).toBeNull();
  });
});

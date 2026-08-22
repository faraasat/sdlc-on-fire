// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { PRESENCE_HEARTBEAT_MS, useRealtime } from './realtime.js';
import { useUiStore } from '../state/ui.js';

/**
 * The presence round-trip (P4-COLLAB-01), across the seam that unit tests miss.
 *
 * `viewers()` is tested in core and `PresenceBar` is tested in jsdom, and both
 * could pass with nothing ever announcing itself or reading a frame — the hook
 * that connects them had no test at all. That gap is the shape of this repo's
 * most repeated defect: every piece works and the person still sees nothing.
 *
 * A fake socket rather than a real one. What is being asserted is the client's
 * half of the protocol — that it announces on open, keeps announcing, and turns
 * an inbound frame into people — none of which needs a server to be true.
 */

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.last = this;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }
}

function Probe(): ReactElement {
  useRealtime();
  return <div />;
}

function wrap(children: ReactNode): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const parsed = (socket: FakeSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  useUiStore.setState({ viewers: [], connection: 'connecting', selectedId: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useRealtime — presence', () => {
  it('announces itself as soon as the socket opens', async () => {
    render(wrap(<Probe />));
    const socket = FakeSocket.last;
    expect(socket).not.toBeNull();
    socket?.open();

    await waitFor(() => {
      expect(parsed(socket as FakeSocket).some((m) => m['type'] === 'presence')).toBe(true);
    });
  });

  it('keeps announcing, so a live client never expires out of the list', async () => {
    vi.useFakeTimers();
    render(wrap(<Probe />));
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    const first = parsed(socket).filter((m) => m['type'] === 'presence').length;

    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2 + 10);
    const later = parsed(socket).filter((m) => m['type'] === 'presence').length;

    // The server drops a client that stops speaking. A heartbeat that never
    // fires produces a board where everyone vanishes while still connected.
    expect(later).toBeGreaterThan(first);
  });

  it('beats faster than the server expires a client', () => {
    // Derived from the TTL rather than written beside it, so retuning one
    // cannot silently leave the other behind.
    expect(PRESENCE_HEARTBEAT_MS).toBeLessThan(30_000 / 2);
  });

  it('turns an inbound frame into people, collapsing one actor’s tabs', async () => {
    render(wrap(<Probe />));
    const socket = FakeSocket.last as FakeSocket;
    socket.open();

    socket.receive({
      type: 'presence',
      here: [
        { clientId: 'c1', actorId: 'ana', displayName: 'Ana', cardId: 'A', seenAt: 1 },
        { clientId: 'c2', actorId: 'ana', displayName: 'Ana', cardId: 'B', seenAt: 2 },
        { clientId: 'c3', actorId: 'bo', displayName: 'Bo', cardId: null, seenAt: 3 },
      ],
    });

    await waitFor(() => {
      expect(useUiStore.getState().viewers).toHaveLength(2);
    });
    const [ana] = useUiStore.getState().viewers;
    expect(ana?.connections).toBe(2);
    expect(ana?.cardIds).toEqual(['A', 'B']);
  });

  it('re-announces the moment the open card changes, without waiting for a beat', async () => {
    // Found by opening the board, not by a test. The first announce goes out
    // before identity resolves and before any card is open; if nothing pushes a
    // fresh one, the daemon keeps labelling the connection by its own id and
    // showing the wrong card until the next heartbeat seconds later.
    render(wrap(<Probe />));
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    const before = parsed(socket).filter((m) => m['type'] === 'presence').length;

    await act(async () => {
      useUiStore.setState({ selectedId: 'P4-COLLAB-01' });
      await Promise.resolve();
    });

    const presence = parsed(socket).filter((m) => m['type'] === 'presence');
    expect(presence.length).toBeGreaterThan(before);
    expect(presence[presence.length - 1]?.['cardId']).toBe('P4-COLLAB-01');
  });

  it('does not treat a presence frame as a change event', async () => {
    // The frames share a socket. A presence broadcast that fell through to the
    // change branch would invalidate every query on every heartbeat of every
    // connected client — a refetch storm that scales with the number of people
    // looking at the board.
    render(wrap(<Probe />));
    const socket = FakeSocket.last as FakeSocket;
    socket.open();
    socket.receive({ type: 'presence', here: [] });

    await waitFor(() => {
      expect(useUiStore.getState().connection).toBe('live');
    });
    expect(useUiStore.getState().viewers).toEqual([]);
  });
});

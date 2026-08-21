// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardCard } from '@sdlc-on-fire/core/browser';
import { useMoveCard } from './mutations.js';
import { queryKeys } from './queries.js';

/**
 * P3-RT-02 — optimistic moves on a board whose server's job is to refuse.
 *
 * Optimism is unusually risky here. In most applications the optimistic guess
 * is nearly always right; on this board a card can only move if its gates pass,
 * so a card sliding forward and jumping back is the *expected* path for gated
 * work rather than an edge case. These pin the behaviour that makes that
 * survivable: it moves immediately, and a refusal puts it back.
 */

const cards: BoardCard[] = [
  { id: 'FEAT-1', title: 'a', type: 'feature', lifecycle_state: 'spec' },
  { id: 'FEAT-2', title: 'b', type: 'feature', lifecycle_state: 'spec' },
];

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.workItems, cards);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubMove(outcome: unknown, delayMs = 0): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(new Response(JSON.stringify(outcome), { status: 200 })),
            delayMs,
          ),
        ),
    ),
  );
}

const stateOf = (id: string): string | undefined =>
  client.getQueryData<BoardCard[]>(queryKeys.workItems)?.find((card) => card.id === id)
    ?.lifecycle_state;

describe('useMoveCard', () => {
  it('paints the move before the daemon answers', async () => {
    stubMove({ moved: true, from: 'spec', to: 'decompose', because: 'moved' }, 40);
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Spec', optimisticStage: 'decompose' });
    await waitFor(() => expect(stateOf('FEAT-1')).toBe('decompose'));
  });

  it('puts the card back when the gate refuses', async () => {
    // A refused move is a *successful* request — 200 with `moved: false` —
    // so rolling back only in `onError` would leave the card sitting somewhere
    // the daemon does not agree it is.
    stubMove({ moved: false, from: 'spec', to: 'done', because: 'gate `tests` has not passed' });
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Done', optimisticStage: 'done' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(stateOf('FEAT-1')).toBe('spec'));
  });

  it('puts the card back when the request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Done', optimisticStage: 'done' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(stateOf('FEAT-1')).toBe('spec');
  });

  it('leaves other cards alone', async () => {
    stubMove({ moved: true, from: 'spec', to: 'decompose', because: 'moved' }, 40);
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Spec', optimisticStage: 'decompose' });
    await waitFor(() => expect(stateOf('FEAT-1')).toBe('decompose'));
    expect(stateOf('FEAT-2')).toBe('spec');
  });

  it('paints nothing when no optimistic stage was resolved', async () => {
    // A column the client cannot resolve is one it should not guess about —
    // painting a move that never happens is worse than waiting for the answer.
    stubMove({ moved: false, from: 'spec', to: null, because: 'not a column' }, 30);
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Nonsense' });
    expect(stateOf('FEAT-1')).toBe('spec');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(stateOf('FEAT-1')).toBe('spec');
  });

  it('is not undone by a refetch that was already in flight', async () => {
    // The reason `onMutate` cancels before writing. A refetch started *before*
    // the drag, resolving *after* the optimistic write, overwrites it with
    // pre-move data — and the card snaps back for a reason that has nothing to
    // do with the daemon's answer, which is indistinguishable from a refusal.
    // A deferred, rather than assigning into a `let` from inside the executor —
    // TypeScript's control-flow analysis cannot see that assignment and narrows
    // the variable to `null`.
    let releaseRefetch = (): void => undefined;
    const slowRefetch = new Promise<BoardCard[]>((resolve) => {
      releaseRefetch = (): void => resolve(cards);
    });

    // In flight before the mutation starts, deliberately not awaited.
    const inFlight = client.fetchQuery({
      queryKey: queryKeys.workItems,
      queryFn: () => slowRefetch,
    });

    stubMove({ moved: true, from: 'spec', to: 'decompose', because: 'moved' }, 60);
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Spec', optimisticStage: 'decompose' });
    await waitFor(() => expect(stateOf('FEAT-1')).toBe('decompose'));

    // Now let the stale refetch land. Cancelled, it must not resurrect 'spec'.
    releaseRefetch();
    await inFlight.catch(() => undefined);
    expect(stateOf('FEAT-1')).toBe('decompose');
  });

  it('refetches whether the move succeeded or was refused', async () => {
    // A refused move can still have changed what the board shows — a gate
    // evaluated, a run started — and refetching only on success hides that.
    stubMove({ moved: false, from: 'spec', to: 'done', because: 'refused' });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMoveCard(), { wrapper });

    result.current.mutate({ id: 'FEAT-1', column: 'Done', optimisticStage: 'done' });
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});

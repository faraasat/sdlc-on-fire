/**
 * The one thing the UI writes (P3-KAN-01), optimistically (P3-RT-02).
 *
 * A drag proposes a move; the daemon's lifecycle guards decide. A refusal comes
 * back as a successful response with `moved: false` and a reason, because the
 * gate saying no is the product working — rendering it as a failed request
 * would put "something went wrong" in front of a user whose move was correctly
 * declined for a reason they need to read.
 *
 * Optimism here is unusually risky and is bounded accordingly. In most apps an
 * optimistic update is nearly always right. Here the server's whole job is to
 * *refuse* — a card can only move if its gates pass — so a card that visibly
 * slides into the next column and then jumps back is not an edge case, it is
 * the expected path for gated work. So the card moves immediately, and a
 * refusal rolls it back **and says why**: the snap-back alone would read as a
 * broken drag rather than as a gate doing its job.
 */

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { BoardCard } from '@sdlc-on-fire/core/browser';
import { api, type MoveOutcome } from './client.js';
import { queryKeys } from './queries.js';

interface MoveVars {
  readonly id: string;
  readonly column: string;
  /** The stage a drop onto that column resolves to, for the optimistic paint. */
  readonly optimisticStage?: string;
}

interface MoveContext {
  readonly previous: BoardCard[] | undefined;
}

export function useMoveCard(): UseMutationResult<MoveOutcome, Error, MoveVars, MoveContext> {
  const queryClient = useQueryClient();

  return useMutation<MoveOutcome, Error, MoveVars, MoveContext>({
    mutationFn: ({ id, column }) => api.move(id, column),

    onMutate: async ({ id, optimisticStage }) => {
      // Cancel first. An in-flight refetch that resolves *after* the optimistic
      // write would overwrite it with pre-move data, and the card would snap
      // back for a reason unrelated to the server's answer.
      await queryClient.cancelQueries({ queryKey: queryKeys.workItems });

      const previous = queryClient.getQueryData<BoardCard[]>(queryKeys.workItems);

      if (optimisticStage !== undefined && previous !== undefined) {
        queryClient.setQueryData<BoardCard[]>(
          queryKeys.workItems,
          previous.map((card) =>
            card.id === id ? { ...card, lifecycle_state: optimisticStage } : card,
          ),
        );
      }

      return { previous };
    },

    onError: (_error, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.workItems, context.previous);
      }
    },

    onSuccess: (outcome, _vars, context) => {
      // A refused move is a *successful* request. Rolling back here rather than
      // only in `onError` is the difference between the card snapping back and
      // the card staying somewhere the daemon does not agree it is.
      if (!outcome.moved && context?.previous !== undefined) {
        queryClient.setQueryData(queryKeys.workItems, context.previous);
      }
    },

    onSettled: () => {
      // Invalidated whether it moved or not. A refused move can still have
      // changed something the board shows — a gate evaluated, a run started —
      // and refetching only on success would leave that invisible.
      void queryClient.invalidateQueries({ queryKey: queryKeys.workItems });
    },
  });
}

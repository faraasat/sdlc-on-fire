/**
 * The one thing the UI writes (P3-KAN-01).
 *
 * A drag proposes a move; the daemon's lifecycle guards decide. A refusal comes
 * back as a successful response with `moved: false` and a reason, because the
 * gate saying no is the product working — rendering it as a failed request
 * would put "something went wrong" in front of a user whose move was correctly
 * declined for a reason they need to read.
 */

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { api, type MoveOutcome } from './client.js';
import { queryKeys } from './queries.js';

export function useMoveCard(): UseMutationResult<
  MoveOutcome,
  Error,
  { id: string; column: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, column }: { id: string; column: string }) => api.move(id, column),
    onSettled: () => {
      // Invalidated whether it moved or not. A refused move can still have
      // changed something the board shows — a gate evaluated, a run started —
      // and refetching only on success would leave that invisible.
      void queryClient.invalidateQueries({ queryKey: queryKeys.workItems });
    },
  });
}

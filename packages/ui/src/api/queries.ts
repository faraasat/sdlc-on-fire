/**
 * Server state (P3-UI-01).
 *
 * Everything here is *fetched*, never authored in the browser. That is the
 * whole distinction from `state/ui.ts`, and it is what makes ADR-0016's
 * firewall structural rather than a rule somebody has to remember: there is no
 * writable server-state store for a UI action to leak into, so a human's
 * interaction reaches an agent only by being persisted through the daemon and
 * coming back out of a context pack.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  api,
  type DocsResponse,
  type LifecycleStateRow,
  type RunRow,
  type TimelineResponse,
  type WorkItemDetail,
  type WorkItemRow,
} from './client.js';
import type { ActivityEntry, ResolvedIdentity, ViewDefinition } from '@sdlc-on-fire/core/browser';

export const queryKeys = {
  identity: ['identity'] as const,
  workItems: ['work-items'] as const,
  workItem: (id: string) => ['work-items', id] as const,
  lifecycleStates: ['lifecycle-states'] as const,
  activity: (workItemId: string | null) => ['activity', workItemId ?? 'all'] as const,
  views: ['views'] as const,
  timeline: (workItemId: string) => ['timeline', workItemId] as const,
  runs: (workItemId: string | null) => ['runs', workItemId ?? 'all'] as const,
  docs: ['docs'] as const,
};

/** Which query key a change to a given table should invalidate. */
export function keysForTable(table: string, id: string): readonly (readonly string[])[] {
  switch (table) {
    case 'work_items':
      return [queryKeys.workItems, queryKeys.workItem(id)];
    // A run, a gate or a comment changes the *card*, not the list — but the
    // list carries the live-run chip, so both are invalidated. Being slightly
    // too eager costs a refetch; being too narrow costs a stale board, and a
    // board that is quietly wrong is the failure this product exists to refuse.
    case 'runs':
    case 'gates':
    case 'comments':
    case 'lifecycle_transitions':
      // These four *are* the feed. A change to any of them makes every activity
      // query stale, including the board-wide one, so the prefix is invalidated
      // rather than the one card's key — a comment on another card still
      // changes what the unscoped feed should show.
      return [queryKeys.workItems, ['activity']];
    default:
      return [];
  }
}

export function useIdentity(): UseQueryResult<ResolvedIdentity> {
  return useQuery({
    queryKey: queryKeys.identity,
    queryFn: api.identity,
    // Identity does not change while a tab is open; refetching it on every
    // focus would be a request per alt-tab for an answer that cannot differ.
    staleTime: Infinity,
  });
}

export function useWorkItems(): UseQueryResult<WorkItemRow[]> {
  return useQuery({ queryKey: queryKeys.workItems, queryFn: api.workItems });
}

export function useWorkItem(id: string | null): UseQueryResult<WorkItemDetail> {
  return useQuery({
    queryKey: queryKeys.workItem(id ?? ''),
    queryFn: () => api.workItem(id as string),
    enabled: id !== null,
  });
}

export function useLifecycleStates(): UseQueryResult<LifecycleStateRow[]> {
  return useQuery({
    queryKey: queryKeys.lifecycleStates,
    queryFn: api.lifecycleStates,
    staleTime: Infinity,
  });
}

export function useActivity(workItemId: string | null): UseQueryResult<ActivityEntry[]> {
  return useQuery({
    queryKey: queryKeys.activity(workItemId),
    queryFn: () => api.activity(workItemId),
  });
}

export function useSavedViews(): UseQueryResult<ViewDefinition[]> {
  return useQuery({
    queryKey: queryKeys.views,
    queryFn: api.views,
    // Views are files on disk that the daemon re-reads per request. Refetching
    // on focus is what makes editing one and alt-tabbing back show the change.
    staleTime: 5_000,
  });
}

/** A card's stage history (P6-SURFACE-04, FEAT-UI-002). */
export function useTimeline(workItemId: string | null): UseQueryResult<TimelineResponse> {
  return useQuery({
    queryKey: queryKeys.timeline(workItemId ?? ''),
    queryFn: () => api.timeline(workItemId as string),
    enabled: workItemId !== null,
  });
}

/** Agent runs, newest first (P6-SURFACE-04, FEAT-UI-005). */
export function useRuns(workItemId: string | null): UseQueryResult<RunRow[]> {
  return useQuery({
    queryKey: queryKeys.runs(workItemId),
    queryFn: () => api.runs(workItemId),
  });
}

/**
 * The doc mirror, projected two ways (FEAT-UI-006/007).
 *
 * One query for both panels: they read the same table, and two queries would
 * mean two caches that can disagree about what is on disk.
 */
export function useDocs(): UseQueryResult<DocsResponse> {
  return useQuery({ queryKey: queryKeys.docs, queryFn: api.docs });
}

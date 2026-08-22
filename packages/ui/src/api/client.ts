/**
 * Talking to the daemon (P3-UI-01).
 *
 * One base URL, and in development it is the empty string: Vite proxies `/api`
 * and `/ws` to the daemon, so this code never learns two base URLs and
 * therefore cannot get the production one wrong. In production the app is
 * served by the daemon itself, same origin, same port.
 */

import type { ActivityEntry, ResolvedIdentity } from '@sdlc-on-fire/core/browser';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let because = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string') because = body.error;
    } catch {
      // A non-JSON error body is still an error; the status carries the meaning.
    }
    throw new ApiError(response.status, because);
  }
  return (await response.json()) as T;
}

export interface WorkItemRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly lifecycle_state: string;
  readonly risk_level: string | null;
  readonly parent_id: string | null;
  readonly claimed_by: string | null;
  readonly claim_kind: string | null;
  readonly lease_expires_at: string | null;
  readonly updated_at: string;
}

export interface WorkItemDetail {
  readonly item: WorkItemRow & Record<string, unknown>;
  readonly gates: readonly Record<string, unknown>[];
  readonly runs: readonly Record<string, unknown>[];
  readonly comments: readonly Record<string, unknown>[];
  readonly transitions: readonly Record<string, unknown>[];
  /** Evidence bound to each gate, with anything that does not add up (P3-KAN-03). */
  readonly binding?: unknown;
}

export interface LifecycleStateRow {
  readonly key: string;
  readonly label: string;
  readonly sort_order: number;
}

export interface MoveOutcome {
  readonly moved: boolean;
  readonly from: string;
  readonly to: string | null;
  readonly because: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, response.statusText);
  return (await response.json()) as T;
}

export const api = {
  move: (id: string, column: string) =>
    post<MoveOutcome>(`/api/work-items/${encodeURIComponent(id)}/move`, { column }),
  health: () => get<{ ok: boolean; version: string }>('/api/health'),
  identity: () => get<ResolvedIdentity>('/api/identity'),
  workItems: () => get<WorkItemRow[]>('/api/work-items'),
  workItem: (id: string) => get<WorkItemDetail>(`/api/work-items/${encodeURIComponent(id)}`),
  lifecycleStates: () => get<LifecycleStateRow[]>('/api/lifecycle-states'),
  activity: (workItemId: string | null) =>
    get<ActivityEntry[]>(
      workItemId === null
        ? '/api/activity'
        : `/api/activity?workItemId=${encodeURIComponent(workItemId)}`,
    ),
};

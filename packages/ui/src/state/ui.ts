/**
 * UI state (P3-UI-01), and the other half of ADR-0016's firewall.
 *
 * Everything in this store is *ephemeral*: which card is open, which filters
 * are applied, which view is showing, who else is on the board. None of it is
 * persisted, none of it is sent to the daemon, and none of it can reach an
 * agent.
 *
 * The rule the firewall actually needs is directional, and it is worth stating
 * that way rather than as "local only". What must never happen is a value a
 * human authors in a browser becoming an agent's context without first being
 * written through the daemon. Inbound ephemera — connection status, presence —
 * came *from* the daemon and can be held here without weakening that: echoing
 * it back could tell an agent nothing it did not already send. Outbound
 * authored content is what this store must never accumulate, and the
 * structural test below is the thing that notices when it starts to.
 *
 * That is the point of keeping it in a separate store from the server state in
 * `api/queries.ts` rather than in one big store holding both. A single store
 * would make "is this value something a human typed into a browser, or
 * something the daemon knows" a question you answer by reading code. Split, it
 * is answered by which import you reached for — and a UI value cannot become an
 * agent's context without somebody first writing it through the daemon, which
 * is exactly the boundary the ADR asks for.
 */

import { create } from 'zustand';
import type { Viewer } from '@sdlc-on-fire/core/browser';

export const THEMES = ['ember', 'slate', 'paper', 'contrast'] as const;
export type Theme = (typeof THEMES)[number];

export const BOARD_VIEWS = ['board', 'table', 'roadmap', 'metrics'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export interface BoardFilters {
  readonly text: string;
  readonly risk: string | null;
  readonly blockedOnly: boolean;
  readonly needsHumanOnly: boolean;
}

export const EMPTY_FILTERS: BoardFilters = {
  text: '',
  risk: null,
  blockedOnly: false,
  needsHumanOnly: false,
};

export interface UiState {
  readonly view: BoardView;
  readonly theme: Theme;
  readonly selectedId: string | null;
  readonly filters: BoardFilters;
  /** Live connection status, shown so a stale board is never silently stale. */
  readonly connection: 'connecting' | 'live' | 'reconnecting' | 'offline';
  /**
   * Who else is on the board, collapsed to one entry per actor by the daemon.
   *
   * Server state, but deliberately not a TanStack query: there is nothing to
   * fetch and nothing to cache. It arrives only over the socket and it is only
   * ever true of *now*, so a cache with a stale time would be a cache of a
   * claim that has already expired. Cleared on disconnect for the same reason —
   * a viewer list rendered over a dead socket is the one failure mode presence
   * exists to avoid, and an empty list is visibly empty where a frozen one
   * looks current.
   */
  readonly viewers: readonly Viewer[];

  setView: (view: BoardView) => void;
  setTheme: (theme: Theme) => void;
  select: (id: string | null) => void;
  setFilters: (patch: Partial<BoardFilters>) => void;
  clearFilters: () => void;
  setConnection: (connection: UiState['connection']) => void;
  setViewers: (viewers: readonly Viewer[]) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'board',
  theme: 'ember',
  selectedId: null,
  filters: EMPTY_FILTERS,
  connection: 'connecting',
  viewers: [],

  setView: (view) => set({ view }),
  setTheme: (theme) => set({ theme }),
  select: (selectedId) => set({ selectedId }),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  clearFilters: () => set({ filters: EMPTY_FILTERS }),
  setConnection: (connection) =>
    set(connection === 'live' ? { connection } : { connection, viewers: [] }),
  setViewers: (viewers) => set({ viewers }),
}));

/** Whether any filter is narrowing the board — drives the "showing a subset" hint. */
export function isFiltered(filters: BoardFilters): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.risk !== null ||
    filters.blockedOnly ||
    filters.needsHumanOnly
  );
}

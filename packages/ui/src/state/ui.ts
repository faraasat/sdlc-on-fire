/**
 * UI state (P3-UI-01), and the other half of ADR-0016's firewall.
 *
 * Everything in this store is *ephemeral and local*: which card is open, which
 * filters are applied, which view is showing. None of it is persisted, none of
 * it is sent to the daemon, and none of it can reach an agent.
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

export const BOARD_VIEWS = ['board', 'table', 'roadmap'] as const;
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
  readonly selectedId: string | null;
  readonly filters: BoardFilters;
  /** Live connection status, shown so a stale board is never silently stale. */
  readonly connection: 'connecting' | 'live' | 'reconnecting' | 'offline';

  setView: (view: BoardView) => void;
  select: (id: string | null) => void;
  setFilters: (patch: Partial<BoardFilters>) => void;
  clearFilters: () => void;
  setConnection: (connection: UiState['connection']) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'board',
  selectedId: null,
  filters: EMPTY_FILTERS,
  connection: 'connecting',

  setView: (view) => set({ view }),
  select: (selectedId) => set({ selectedId }),
  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  clearFilters: () => set({ filters: EMPTY_FILTERS }),
  setConnection: (connection) => set({ connection }),
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

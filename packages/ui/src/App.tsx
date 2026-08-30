import { useState, type ReactElement } from 'react';
import { useDocs, useIdentity, useSavedViews, useWorkItems } from './api/queries.js';
import { useMoveCard } from './api/mutations.js';
import { useRealtime } from './api/realtime.js';
import { BOARD_VIEWS, isCardView, isFiltered, useUiStore } from './state/ui.js';
import { IdentityBadge } from './components/IdentityBadge.js';
import { ConnectionDot } from './components/ConnectionDot.js';
import { PresenceBar } from './components/PresenceBar.js';
import { ViewPicker } from './components/ViewPicker.js';
import { BoardView } from './components/BoardView.js';
import { TableView } from './components/TableView.js';
import { RoadmapView } from './components/RoadmapView.js';
import { CardDrawer } from './components/CardDrawer.js';
import { MetricsView } from './components/MetricsView.js';
import { ResearchPanel } from './components/ResearchPanel.js';
import { DecisionLog } from './components/DecisionLog.js';
import { ThemePicker } from './components/ThemePicker.js';
import { GROUP_BY, type BoardCard, type GroupBy } from '@sdlc-on-fire/core/browser';

/**
 * The app shell (P3-UI-01) and the three views (P3-KAN-01).
 *
 * The projection lives in core's `projectBoard`, not in this render, so what a
 * board *claims* about the state of work is testable without a browser.
 */
export function App(): ReactElement {
  useRealtime();

  const identity = useIdentity();
  const items = useWorkItems();
  const savedViews = useSavedViews();
  // One query for both panels: they read the same mirror, and two caches can
  // disagree about what is on disk.
  const docs = useDocs();
  const move = useMoveCard();
  const { view, setView, filters, setFilters, clearFilters, selectedId, select, viewers } =
    useUiStore();
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [refusal, setRefusal] = useState<string | null>(null);

  const cards = (items.data ?? []) as unknown as BoardCard[];

  // The table and roadmap filter on text only; the board's own projection
  // applies the full filter set, so applying it twice here would double-filter.
  const textFiltered = cards.filter((card) => {
    const text = filters.text.trim().toLowerCase();
    return text === '' || `${card.id} ${card.title}`.toLowerCase().includes(text);
  });

  return (
    <div className="app">
      <header className="app__bar">
        <strong className="app__brand">SDLC on Fire</strong>
        <nav className="app__views">
          {BOARD_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={view === candidate}
              onClick={() => setView(candidate)}
            >
              {candidate}
            </button>
          ))}
        </nav>

        {view === 'board' ? (
          <label className="app__group">
            group
            <select
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value as GroupBy)}
              aria-label="group cards into swimlanes"
            >
              {GROUP_BY.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <input
          className="app__search"
          type="search"
          placeholder="filter by id or title"
          value={filters.text}
          onChange={(event) => setFilters({ text: event.target.value })}
          aria-label="filter work items"
        />
        <button
          type="button"
          className={filters.blockedOnly ? 'toggle toggle--on' : 'toggle'}
          aria-pressed={filters.blockedOnly}
          onClick={() => setFilters({ blockedOnly: !filters.blockedOnly })}
        >
          blocked
        </button>
        <button
          type="button"
          className={filters.needsHumanOnly ? 'toggle toggle--on' : 'toggle'}
          aria-pressed={filters.needsHumanOnly}
          onClick={() => setFilters({ needsHumanOnly: !filters.needsHumanOnly })}
        >
          needs a human
        </button>
        <ThemePicker />
        <ViewPicker views={savedViews.data ?? []} onGroupBy={setGroupBy} />
        <PresenceBar viewers={viewers} selfActorId={identity.data?.actor?.id ?? null} />
        <ConnectionDot />
        <IdentityBadge identity={identity.data} />
      </header>

      <main className="app__main">
        {items.isPending ? <p className="muted">loading the board…</p> : null}

        {items.isError ? (
          <p className="error" role="alert">
            could not reach the daemon: {items.error.message}
          </p>
        ) : null}

        {refusal !== null ? (
          // The gate's own words, on screen. A refused move is the product
          // working; the user needs the reason, not a generic failure.
          <p className="warn" role="alert">
            {refusal}{' '}
            <button type="button" onClick={() => setRefusal(null)}>
              dismiss
            </button>
          </p>
        ) : null}

        {items.isSuccess && cards.length === 0 ? (
          <p className="muted">
            {isFiltered(filters) ? (
              <>
                nothing matches this filter.{' '}
                <button type="button" onClick={clearFilters}>
                  clear it
                </button>
              </>
            ) : (
              <>no work items yet — run `sdlc capture` to add one</>
            )}
          </p>
        ) : null}

        {/* Card views only, and not the board — it renders its own empty state. On a
            panel view the card filter is not what the reader is looking at, and
            "nothing matches this filter" over a decision log is nonsense. */}
        {items.isSuccess &&
        cards.length > 0 &&
        textFiltered.length === 0 &&
        isCardView(view) &&
        view !== 'board' ? (
          <p className="muted">
            nothing matches this filter.{' '}
            <button type="button" onClick={clearFilters}>
              clear it
            </button>
          </p>
        ) : null}

        {view === 'metrics' ? <MetricsView /> : null}
        {view === 'research' ? (
          <ResearchPanel index={docs.data?.research} loading={docs.isLoading} />
        ) : null}
        {view === 'decisions' ? (
          <DecisionLog log={docs.data?.decisions} loading={docs.isLoading} />
        ) : null}

        {isCardView(view) && items.isSuccess && cards.length > 0 ? (
          view === 'board' ? (
            <BoardView
              cards={cards}
              groupBy={groupBy}
              filter={filters}
              onMove={(id, column, optimisticStage) => {
                move.mutate(
                  { id, column, ...(optimisticStage === undefined ? {} : { optimisticStage }) },
                  {
                    onSuccess: (outcome) => {
                      setRefusal(outcome.moved ? null : outcome.because);
                    },
                    onError: (error) => setRefusal(error.message),
                  },
                );
              }}
              onClearFilters={clearFilters}
            />
          ) : view === 'table' ? (
            <TableView cards={textFiltered} />
          ) : (
            <RoadmapView cards={textFiltered} />
          )
        ) : null}
      </main>

      {selectedId === null ? null : <CardDrawer cardId={selectedId} onClose={() => select(null)} />}
    </div>
  );
}

import type { ReactElement } from 'react';
import { useIdentity, useWorkItems } from './api/queries.js';
import { useRealtime } from './api/realtime.js';
import { isFiltered, useUiStore } from './state/ui.js';
import { IdentityBadge } from './components/IdentityBadge.js';
import { ConnectionDot } from './components/ConnectionDot.js';

/**
 * The app shell (P3-UI-01).
 *
 * Deliberately thin. What this task delivers is the *seams* — server state
 * behind TanStack Query, UI state behind Zustand, identity resolved and shown
 * with its ground, and a live connection whose status is never hidden. The
 * board itself is [P3-KAN-01] and lands on top of these.
 */
export function App(): ReactElement {
  useRealtime();

  const identity = useIdentity();
  const items = useWorkItems();
  const { view, setView, filters, setFilters, clearFilters } = useUiStore();

  const visible = (items.data ?? []).filter((item) => {
    const text = filters.text.trim().toLowerCase();
    if (text !== '' && !`${item.id} ${item.title}`.toLowerCase().includes(text)) return false;
    if (filters.risk !== null && item.risk_level !== filters.risk) return false;
    return true;
  });

  return (
    <div className="app">
      <header className="app__bar">
        <strong className="app__brand">SDLC on Fire</strong>
        <nav className="app__views">
          {(['board', 'table', 'roadmap'] as const).map((candidate) => (
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
        <input
          className="app__search"
          type="search"
          placeholder="filter by id or title"
          value={filters.text}
          onChange={(event) => setFilters({ text: event.target.value })}
          aria-label="filter work items"
        />
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

        {items.isSuccess && visible.length === 0 ? (
          <p className="muted">
            {isFiltered(filters) ? (
              <>
                nothing matches this filter.{' '}
                <button type="button" onClick={clearFilters}>
                  clear it
                </button>
              </>
            ) : (
              // Distinguished from a filtered-empty board on purpose: "you have
              // no work items" and "your filter hides all of them" ask for
              // opposite next actions.
              <>no work items yet — run `sdlc capture` to add one</>
            )}
          </p>
        ) : null}

        {visible.length > 0 ? (
          <ul className="cards">
            {visible.map((item) => (
              <li key={item.id} className={`card card--${item.lifecycle_state}`}>
                <code>{item.id}</code> <span>{item.title}</span>
                <small>{item.lifecycle_state}</small>
              </li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

/**
 * Saved views, on screen (P4-COLLAB-03).
 *
 * Applying a view sets the same three pieces of UI state a person can set by
 * hand — mode, grouping, filters — rather than putting the board into a
 * distinct "view mode". That is deliberate: a view is a stored argument list,
 * so applying one must be indistinguishable from having typed it, and the
 * controls must stay live afterwards. A board that locked when a view was
 * applied would make "start from this view and narrow it" impossible, which is
 * the thing people actually do with saved views.
 *
 * It follows that there is no "currently applied" highlight. Once applied, the
 * state is just board state and the user may have changed it; showing a view as
 * still-selected would be a claim we cannot check without re-deriving it, and
 * it would be wrong the moment somebody typed in the filter box.
 */

import type { ReactElement } from 'react';
import type { ViewDefinition } from '@sdlc-on-fire/core/browser';
import { EMPTY_FILTERS, useUiStore } from '../state/ui.js';

export function ViewPicker({
  views,
  onGroupBy,
}: {
  readonly views: readonly ViewDefinition[];
  /**
   * Grouping lives in the shell's local state rather than the UI store, so it
   * is set through a callback. Keeping it out of the store is the reason the
   * ADR-0016 firewall assertion over that store stays a short, readable list.
   */
  readonly onGroupBy: (groupBy: ViewDefinition['groupBy']) => void;
}): ReactElement | null {
  const setView = useUiStore((state) => state.setView);
  const setFilters = useUiStore((state) => state.setFilters);

  // Nothing rather than an empty dropdown. A control offering no choices reads
  // as broken; absent reads as "this project has no saved views", which is true.
  if (views.length === 0) return null;

  const apply = (slug: string): void => {
    const view = views.find((candidate) => candidate.slug === slug);
    if (view === undefined) return;
    setView(view.mode);
    onGroupBy(view.groupBy);
    // Reset first, then apply. Merging into whatever was there means a view
    // that does not mention `blockedOnly` inherits the last one's — so the
    // board you get depends on the board you came from.
    setFilters({ ...EMPTY_FILTERS, ...view.filter });
  };

  return (
    <label className="app__group">
      <span>view</span>
      <select
        aria-label="apply a saved view"
        // Always reads "—": see the note above on why there is no selected state.
        value=""
        onChange={(event) => {
          apply(event.target.value);
          event.target.value = '';
        }}
      >
        <option value="">—</option>
        {views.map((view) => (
          <option key={view.slug} value={view.slug}>
            {view.name}
            {view.role === null ? '' : ` (${view.role})`}
          </option>
        ))}
      </select>
    </label>
  );
}

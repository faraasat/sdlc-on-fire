import type { ReactElement } from 'react';
import type { RunRow } from '../api/client.js';

/**
 * The agent-run viewer (P6-SURFACE-04, FEAT-UI-005, FEAT-KAN-008).
 *
 * "See exactly what an agent did" is the whole claim, so the rules here are
 * about not softening it.
 *
 * **A run with no reported cost says so.** `NULL` and `0` are different facts —
 * a transport that reported nothing versus a run that was free — and rendering
 * both as `$0.0000` would be the view inventing the more flattering one.
 *
 * **A failure reason is shown as recorded**, from the closed vocabulary the
 * dispatcher assigned. Restating it in friendlier words would be a second
 * classification of the same event, and the two would diverge.
 */

export interface RunViewerProps {
  readonly runs: readonly RunRow[] | undefined;
  readonly loading?: boolean;
}

const MARK: Readonly<Record<string, string>> = {
  pass: '✓',
  fail: '✗',
  error: '✗',
  running: '·',
  pending: '·',
};

function elapsed(run: RunRow): string {
  if (run.started_at === null || run.finished_at === null) return '—';
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  return Number.isNaN(ms) ? '—' : `${String(Math.round(ms / 1000))}s`;
}

function cost(run: RunRow): string {
  // Never `?? 0`. See the note above.
  if (run.cost_usd === null) return 'cost not reported';
  const value = Number(run.cost_usd);
  return Number.isNaN(value) ? 'cost not reported' : `$${value.toFixed(4)}`;
}

export function RunViewer({ runs, loading = false }: RunViewerProps): ReactElement {
  if (loading) return <p className="runs__empty">loading…</p>;
  if (runs === undefined || runs.length === 0) {
    return <p className="runs__empty">no agent runs recorded</p>;
  }

  return (
    <section className="runs" aria-label="Agent runs">
      <ol className="runs__list">
        {runs.map((run) => (
          <li key={run.id} className={`runs__item runs__item--${run.status ?? 'unknown'}`}>
            <span className="runs__mark">{MARK[run.status ?? ''] ?? '?'}</span>
            <span className="runs__skill">{run.skill_id ?? '(no skill)'}</span>
            <span className="runs__status">{run.status ?? 'unknown'}</span>
            <span className="runs__model">{run.model ?? '(model not recorded)'}</span>
            <span className="runs__elapsed">{elapsed(run)}</span>
            <span className="runs__cost">{cost(run)}</span>
            {run.turns === null ? null : <span className="runs__turns">{run.turns} turn(s)</span>}
            {run.failure_reason === null ? null : (
              <span className="runs__reason">reason: {run.failure_reason}</span>
            )}
            {/* The pack is the evidence of what the agent was actually asked.
                Naming the path is what makes a run reviewable at all. */}
            {run.context_pack_path === null ? (
              <span className="runs__pack runs__pack--missing">no context pack recorded</span>
            ) : (
              <code className="runs__pack">{run.context_pack_path}</code>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

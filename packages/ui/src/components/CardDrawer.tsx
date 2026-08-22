import { useEffect, useRef, type ReactElement } from 'react';
import {
  cardProgress,
  summariseBinding,
  type BindingReport,
  type DotState,
} from '@sdlc-on-fire/core/browser';
import { useWorkItem } from '../api/queries.js';

/**
 * The card detail drawer (P3-KAN-02).
 *
 * Everything a card face cannot fit: the full gate list with results, the run
 * history, role-attributed comments, and progress dots derived from what the
 * card actually did.
 *
 * A drawer rather than a route, because the board is the context. Losing the
 * board to read one card and then having to find your place again is the
 * interaction people stop using.
 */

const EFFECT_SEVERITY: Readonly<Record<string, string>> = {
  GATE_BLOCK: 'bad',
  REQUIRED_CHANGE: 'bad',
  BUG_CREATION: 'bad',
  RESCOPE: 'warn',
  UX_ACCEPTANCE_UPDATE: 'warn',
  DECISION_TO_MEMORY: 'ok',
  CONTEXT_INJECTION: 'ok',
  NONE: 'muted',
};

const DOT_TITLE: Readonly<Record<DotState, string>> = {
  done: 'been through this stage',
  current: 'here now',
  pending: 'not reached yet',
  skipped: 'required, and jumped over',
};

/**
 * Render an unknown database value as text.
 *
 * `String(value)` on an object produces `[object Object]` on the screen, which
 * is the kind of defect that survives review because it only appears for the
 * one column somebody later changes to JSON. Objects and nullish values render
 * as empty rather than as a literal that looks like a bug report.
 */
function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return fallback;
}

export function CardDrawer({
  cardId,
  onClose,
}: {
  cardId: string;
  onClose: () => void;
}): ReactElement {
  const detail = useWorkItem(cardId);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves into the drawer when it opens and Escape closes it. Without
  // both, a keyboard user opens a panel they cannot reach and cannot leave.
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const item = detail.data?.item;
  const binding = detail.data?.binding as BindingReport | undefined;
  const transitions = detail.data?.transitions ?? [];
  const progress =
    item === undefined
      ? null
      : cardProgress(
          text(item['lifecycle_state'], ''),
          transitions.map((row) => text(row['to_state'], '')),
          text(item['preset'], 'standard'),
          text(item['work_type'], 'feature'),
        );

  return (
    <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Card ${cardId}`}>
      <header className="drawer__head">
        <code>{cardId}</code>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="close card details">
          ×
        </button>
      </header>

      {detail.isPending ? <p className="muted">loading…</p> : null}
      {detail.isError ? (
        <p className="error" role="alert">
          {detail.error.message}
        </p>
      ) : null}

      {item !== undefined ? (
        <div className="drawer__body">
          <h2>{text(item['title'], '')}</h2>

          {progress !== null && progress.total > 0 ? (
            <section>
              <h3>Progress</h3>
              <ol
                className="dots"
                aria-label={`${String(progress.doneCount)} of ${String(progress.total)} stages complete`}
              >
                {progress.dots.map((dot) => (
                  <li
                    key={dot.stage}
                    className={`dot dot--${dot.state}${dot.revisited ? ' dot--revisited' : ''}`}
                    title={`${dot.stage}: ${DOT_TITLE[dot.state]}${dot.revisited ? ' (returned to)' : ''}`}
                  >
                    <span className="sr-only">
                      {dot.stage}: {DOT_TITLE[dot.state]}
                    </span>
                  </li>
                ))}
              </ol>
              {progress.extra.length > 0 ? (
                <p className="muted">
                  also went through {progress.extra.join(', ')} — more than this preset requires
                </p>
              ) : null}
            </section>
          ) : null}

          <section>
            <h3>Gates and the evidence behind them</h3>
            {binding === undefined || binding.gates.length === 0 ? (
              // Never rendered as a pass. A card nothing has checked has not
              // passed anything — the distinction this product exists for.
              <p className="muted">no gate has run on this card</p>
            ) : (
              <ul className="plain">
                {binding.gates.map((bound) => (
                  <li
                    key={bound.gate.id}
                    className={bound.problems.length > 0 ? 'bound bound--bad' : 'bound'}
                  >
                    <span className={`chip chip--${bound.gate.result ?? 'pending'}`}>
                      {bound.gate.result ?? 'pending'}
                    </span>{' '}
                    {bound.gate.gate_name}
                    {/* The envelopes, or the reason there is a problem with
                        them. A green gate you cannot inspect is the shape this
                        product refuses from an agent. */}
                    <small className={bound.problems.length > 0 ? 'error' : 'muted'}>
                      {summariseBinding(bound)}
                    </small>
                    {bound.evidence.length > 0 ? (
                      <ul className="plain envelopes">
                        {bound.evidence.map((row) => (
                          <li key={row.id}>
                            <code>{row.kind}</code> by {row.producer} at{' '}
                            <code>{row.git_sha.slice(0, 8)}</code>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {binding !== undefined && binding.unbound.length > 0 ? (
              // Produced, stored, satisfying nothing. In a list it looks like
              // coverage.
              <p className="warn">
                {binding.unbound.length} envelope(s) are attached to no gate — they satisfy nothing.
              </p>
            ) : null}
          </section>

          <section>
            <h3>Runs</h3>
            {detail.data?.runs.length === 0 ? (
              <p className="muted">nothing has run yet</p>
            ) : (
              <ul className="plain">
                {detail.data?.runs.map((run, index) => (
                  <li key={index}>
                    <span className={`chip chip--${text(run['status'], '')}`}>
                      {text(run['status'], 'unknown')}
                    </span>{' '}
                    <code>{text(run['id'], '')}</code>{' '}
                    <small>{text(run['model'] ?? run['agent_target'], '')}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Comments</h3>
            {detail.data?.comments.length === 0 ? (
              <p className="muted">no comments</p>
            ) : (
              <ul className="comments">
                {detail.data?.comments.map((comment, index) => {
                  const effect = text(comment['role_effect'], 'NONE');
                  return (
                    <li
                      key={index}
                      className={`comment comment--${EFFECT_SEVERITY[effect] ?? 'muted'}`}
                    >
                      <header>
                        <strong>{text(comment['type'], 'normal')}</strong>
                        {/* The effect, not the body, is what consumers read
                            (ADR-0012) — it is computed server-side at insert and
                            never re-derived, so showing it is showing the thing
                            that actually acted. */}
                        {effect === 'NONE' ? null : <span className="chip">{effect}</span>}
                        {comment['addressed_to'] == null ? null : (
                          <small>→ {text(comment['addressed_to'])}</small>
                        )}
                      </header>
                      <p>{text(comment['body'], '')}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </aside>
  );
}

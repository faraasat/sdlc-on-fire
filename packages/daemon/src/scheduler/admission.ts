import type { BudgetScope, StoragePort } from '@sdlc-on-fire/core';

/**
 * Admission control + AIMD backpressure (P1-SCHED-01, ADR-0020).
 *
 * Three separate jobs, kept separate because they fail differently:
 *
 * 1. **Admission** — may this run start at all? Decided against the token
 *    budget *before* spending anything. Checking after the fact turns a limit
 *    into a report.
 * 2. **Backpressure** — how many may run at once? Adjusted by AIMD from what
 *    the provider actually does, not from what we hoped it would do.
 * 3. **Thresholds** — 85% checkpoint, 100% stop. The first exists so a long run
 *    saves its work before the second one cuts it off; without it, hitting the
 *    limit discards everything done since the last checkpoint.
 */

/** Where a run stands against its budget. */
export type AdmissionVerdict = 'admit' | 'checkpoint' | 'deny';

export interface AdmissionDecision {
  readonly verdict: AdmissionVerdict;
  readonly reason: string;
  readonly usedFraction: number;
}

/** Fraction at which a run is told to checkpoint while it still can. */
export const CHECKPOINT_THRESHOLD = 0.85;

/**
 * Decides whether a run may start.
 *
 * `checkpoint` is an admission *verdict*, not a warning: the run proceeds, but
 * it has been told to save state now. Making it advisory would mean the only
 * signal arrives at 100%, which is exactly when there is no room left to act.
 */
export async function admit(
  store: Pick<StoragePort, 'budgetFor'>,
  input: {
    readonly scope: BudgetScope;
    readonly scopeId: string;
    readonly estimatedTokens: number;
    readonly at: Date;
  },
): Promise<AdmissionDecision> {
  const budget = await store.budgetFor(input.scope, input.scopeId, input.at);

  // No budget configured is not the same as no budget left. Denying here would
  // block every workspace that never set one, which is most of them.
  if (budget === null) {
    return { verdict: 'admit', reason: 'no budget configured for this scope', usedFraction: 0 };
  }

  const projected = budget.usedTokens + input.estimatedTokens;
  const usedFraction = budget.limitTokens === 0 ? 1 : projected / budget.limitTokens;

  if (projected > budget.limitTokens) {
    return {
      verdict: 'deny',
      reason:
        `starting this run would need ${String(projected)} of ${String(budget.limitTokens)} tokens ` +
        `(${String(budget.remainingTokens)} remain)`,
      usedFraction,
    };
  }
  if (usedFraction >= CHECKPOINT_THRESHOLD) {
    return {
      verdict: 'checkpoint',
      reason: `budget ${Math.round(usedFraction * 100)}% consumed — checkpoint before continuing`,
      usedFraction,
    };
  }
  return { verdict: 'admit', reason: 'within budget', usedFraction };
}

export interface AimdOptions {
  /** Never drop below this, or a single bad minute stalls the daemon entirely. */
  readonly floor?: number | undefined;
  /** Hard ceiling regardless of how well things are going (ADR-0029 caps at 8). */
  readonly ceiling?: number | undefined;
}

/**
 * Additive-increase / multiplicative-decrease concurrency control.
 *
 * The asymmetry is the whole design. Increase slowly (+1 per success) because
 * headroom is a guess; decrease sharply (halve on rejection) because a provider
 * that just refused us is not going to be persuaded by trying almost as hard.
 * Symmetric backoff oscillates: it climbs straight back into the wall it just
 * hit.
 */
export class AimdLimiter {
  #limit: number;
  readonly #floor: number;
  readonly #ceiling: number;

  constructor(initial = 2, options: AimdOptions = {}) {
    this.#floor = options.floor ?? 1;
    this.#ceiling = options.ceiling ?? 8;
    this.#limit = Math.min(Math.max(initial, this.#floor), this.#ceiling);
  }

  get limit(): number {
    return this.#limit;
  }

  /** A run completed without provider pushback. */
  onSuccess(): number {
    this.#limit = Math.min(this.#limit + 1, this.#ceiling);
    return this.#limit;
  }

  /** The provider rate-limited or refused us. */
  onRejection(): number {
    this.#limit = Math.max(Math.floor(this.#limit / 2), this.#floor);
    return this.#limit;
  }
}

/**
 * Records what a provider told us about its own limits.
 *
 * Stored as reported, never recomputed from a local clock: skew against a rate
 * limiter makes a scheduler back off for the wrong duration, and it errs in
 * whichever direction the clock happens to be wrong.
 */
export async function recordProviderLimits(
  store: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
  input: {
    readonly provider: string;
    readonly requestsRemaining?: number | undefined;
    readonly tokensRemaining?: number | undefined;
    readonly resetsAt?: string | undefined;
    readonly retryAfterMs?: number | undefined;
  },
): Promise<void> {
  await store.query(
    `INSERT INTO provider_rate_limits
       (provider, requests_remaining, tokens_remaining, resets_at, retry_after_ms, observed_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (provider) DO UPDATE SET
       requests_remaining = EXCLUDED.requests_remaining,
       tokens_remaining = EXCLUDED.tokens_remaining,
       resets_at = EXCLUDED.resets_at,
       retry_after_ms = EXCLUDED.retry_after_ms,
       observed_at = now();`,
    [
      input.provider,
      input.requestsRemaining ?? null,
      input.tokensRemaining ?? null,
      input.resetsAt ?? null,
      input.retryAfterMs ?? null,
    ],
  );
}

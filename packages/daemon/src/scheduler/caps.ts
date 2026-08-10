import {
  CapExceededError,
  MAX_CONCURRENCY,
  MAX_RECURSION_DEPTH,
  MAX_WAVE_COUNT,
} from '@sdlc-on-fire/core';
/**
 * Subagent cap enforcement (P1-SCHED-03, ADR-0029).
 *
 * Three limits, each preventing a different runaway:
 *
 * - **Concurrency (≤8)** — how many run at once. Protects the provider and the
 *   machine.
 * - **Per-wave count** — how many a single wave may spawn in total. Protects
 *   the budget: eight at a time, five hundred in sequence, is still five
 *   hundred.
 * - **Recursion depth (≤2)** — how deep subagents may spawn subagents. This is
 *   the one that turns a bug into a bill, because the growth is exponential and
 *   nothing else here bounds it.
 *
 * Enforced by refusal, never by silent truncation. A wave that quietly dropped
 * its ninth task would produce a partial result indistinguishable from a
 * complete one — and the caller would act on it as though everything ran.
 */

// One source for the numbers (core), two enforcement points: here for a wave,
// and at the agent manager's dispatch boundary for a single spawn. Re-exported
// so existing importers of this module are unaffected.
export {
  CapExceededError,
  MAX_CONCURRENCY,
  MAX_RECURSION_DEPTH,
  MAX_WAVE_COUNT,
} from '@sdlc-on-fire/core';

export interface WaveRequest {
  readonly waveId: string;
  readonly taskCount: number;
  /** 0 for a wave the human started; 1 for a wave a subagent started. */
  readonly depth: number;
  readonly concurrency?: number | undefined;
}

export interface WavePlan {
  readonly waveId: string;
  readonly taskCount: number;
  readonly concurrency: number;
  readonly depth: number;
}

/**
 * Validates a wave before any of it runs.
 *
 * Rejecting up front rather than mid-flight matters: half a wave is worse than
 * none, because its partial output looks like a whole one and there is no
 * marker saying otherwise.
 */
export function planWave(request: WaveRequest): WavePlan {
  if (request.depth > MAX_RECURSION_DEPTH) {
    throw new CapExceededError(
      'recursion-depth',
      `wave "${request.waveId}" is at depth ${String(request.depth)}, beyond the limit of ` +
        `${String(MAX_RECURSION_DEPTH)}. Subagents spawning subagents grows exponentially, and ` +
        'nothing downstream of here bounds it.',
    );
  }
  if (request.taskCount > MAX_WAVE_COUNT) {
    throw new CapExceededError(
      'wave-count',
      `wave "${request.waveId}" declares ${String(request.taskCount)} tasks, beyond the ceiling of ` +
        `${String(MAX_WAVE_COUNT)}. Eight at a time and five hundred in sequence is still five hundred; ` +
        'split it into waves you have decided to run.',
    );
  }

  const requested = request.concurrency ?? MAX_CONCURRENCY;
  if (requested > MAX_CONCURRENCY) {
    throw new CapExceededError(
      'concurrency',
      `wave "${request.waveId}" requests concurrency ${String(requested)}, beyond the cap of ` +
        `${String(MAX_CONCURRENCY)} (ADR-0029).`,
    );
  }

  return {
    waveId: request.waveId,
    taskCount: request.taskCount,
    concurrency: Math.max(1, Math.min(requested, request.taskCount || 1)),
    depth: request.depth,
  };
}

/**
 * Tracks live subagents against the cap.
 *
 * Deliberately a counter rather than a queue. Queuing is the scheduler's job
 * (`P1-SCHED-02`); this only answers "may one more start", so the cap cannot be
 * defeated by a caller that manages its own queue.
 */
export class ConcurrencyGovernor {
  #active = 0;
  readonly #limit: number;

  constructor(limit: number = MAX_CONCURRENCY) {
    if (limit > MAX_CONCURRENCY) {
      throw new CapExceededError(
        'concurrency',
        `governor limit ${String(limit)} exceeds the ADR-0029 cap of ${String(MAX_CONCURRENCY)}`,
      );
    }
    this.#limit = Math.max(1, limit);
  }

  get active(): number {
    return this.#active;
  }

  get limit(): number {
    return this.#limit;
  }

  /** `false` when the caller must wait. Never blocks — the caller decides how to. */
  tryAcquire(): boolean {
    if (this.#active >= this.#limit) return false;
    this.#active += 1;
    return true;
  }

  /**
   * Releases a slot.
   *
   * Clamped at zero. An unbalanced release would otherwise drive the counter
   * negative and quietly raise the effective cap — a leak that makes the limit
   * look enforced while it is not.
   */
  release(): void {
    this.#active = Math.max(0, this.#active - 1);
  }
}

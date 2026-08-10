/**
 * The subagent caps, as constants both enforcement points read (ADR-0029).
 *
 * These lived in the daemon's scheduler, where `planWave` validated them — and
 * `planWave` had no caller anywhere in the product. The depth cap in particular
 * is the one that turns a bug into a bill, since subagent growth is exponential
 * and nothing else bounds it, so an unenforced version of it is worse than none:
 * it reads, in review, exactly like a limit.
 *
 * They sit in core because the two places that must enforce them — the wave
 * planner in the daemon and the dispatch boundary in the agent manager — cannot
 * import each other. A second copy of the number would eventually be a different
 * number.
 */

/** How many subagents may run at once. Protects the provider and the machine. */
export const MAX_CONCURRENCY = 8;

/**
 * How many a single wave may spawn in total.
 *
 * Protects the budget rather than the machine: eight at a time, five hundred in
 * sequence, is still five hundred.
 */
export const MAX_WAVE_COUNT = 32;

/**
 * How deep subagents may spawn subagents.
 *
 * 0 is a dispatch a human started, 1 is one a subagent started. Beyond 2 the
 * growth is exponential and nothing downstream bounds it.
 */
export const MAX_RECURSION_DEPTH = 2;

export type CapName = 'concurrency' | 'wave-count' | 'recursion-depth';

export class CapExceededError extends Error {
  override readonly name = 'CapExceededError';
  constructor(
    readonly cap: CapName,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Refuses a spawn beyond the depth limit.
 *
 * Refusal, not clamping. A spawn silently executed at depth 2 when the caller
 * asked for depth 3 produces a result the caller believes came from a deeper
 * search than actually ran.
 */
export function assertWithinDepth(depth: number, what: string): void {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new CapExceededError(
      'recursion-depth',
      `${what} is at recursion depth ${String(depth)}, beyond the limit of ` +
        `${String(MAX_RECURSION_DEPTH)} (ADR-0029). Subagents spawning subagents grows ` +
        'exponentially, and nothing downstream bounds it — flatten the work instead.',
    );
  }
}

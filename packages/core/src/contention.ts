/**
 * Running a claim under contention, reproducibly (P3-QA-12,
 * `.research/techniques/45` §2).
 *
 * This codebase has real races — claim/lease acquisition, the worktree mirror,
 * the file watcher against its own writes, the sync engine — and every one
 * found so far was found *by accident*. That is not a strategy; it is a run of
 * luck that ends the first time one of them costs somebody a work item.
 *
 * The cheap technique, chosen deliberately over the expensive one. Systematic
 * interleaving exploration and full deterministic simulation testing are more
 * powerful and require every source of nondeterminism to be injectable — a
 * design constraint on the code rather than a test you add. What is here is
 * repeated contended runs with **a recorded seed**, which buys the one property
 * that makes a flaky failure actionable: the ability to run it again and see it
 * again.
 *
 * The honest limit, stated because a seed looks like more than it is: this
 * makes the *jitter* reproducible, not the OS scheduler. Re-running a seed
 * reproduces the shape of the contention, not the exact interleaving. It turns
 * "it failed once on CI" into "it fails about one run in twelve at seed 7",
 * which is the difference between a bug you can chase and one you argue about.
 */

/**
 * A small deterministic PRNG (mulberry32).
 *
 * Not cryptographic and not trying to be. What is needed is that the same seed
 * gives the same sequence in every process, which `Math.random` cannot promise
 * and which is the entire reason the seed is recorded.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ContentionOptions<T> {
  /** Recorded and reported, so a failure can be replayed. */
  readonly seed: number;
  /** Concurrent actors per round. */
  readonly actors: number;
  /** How many times to repeat. A race that shows up one run in twenty needs twenty. */
  readonly rounds: number;
  /** Runs once per round before the actors start — reset state here. */
  readonly setup?: (round: number) => Promise<void> | void;
  /** One actor's attempt. Rejections are captured, never thrown. */
  readonly attempt: (actor: number, round: number) => Promise<T>;
  /**
   * Upper bound on the seeded delay before each actor starts.
   *
   * **Default 0, and that default is load-bearing.** Any positive jitter longer
   * than the operation under test staggers the actors past each other and the
   * harness measures nothing. Raise it only to explore interleavings *within* a
   * longer operation, never in the hope of "more randomness".
   */
  readonly jitterMaxMs?: number;
}

export interface ActorOutcome<T> {
  readonly actor: number;
  readonly value: T | null;
  readonly error: string | null;
}

export interface RoundOutcome<T> {
  readonly round: number;
  readonly outcomes: readonly ActorOutcome<T>[];
}

export interface ContentionResult<T> {
  readonly seed: number;
  readonly actors: number;
  readonly rounds: readonly RoundOutcome<T>[];
  /** Replay instruction, ready to paste into a failure message. */
  readonly replay: string;
}

/**
 * Wait, without serialising the actors that are meant to collide.
 *
 * A zero-length wait must **not** become `setTimeout(…, 0)`. Timers each fire
 * in their own macrotask, so an actor that yields to one resumes, runs its
 * whole database round trip, and finishes before the next actor's timer fires —
 * every actor ends up alone. That is not a subtle degradation; it removes all
 * contention, and the harness reports a clean run on code that is plainly
 * racy. Found by mutating `claim` into check-then-act and watching the
 * concurrency tier stay green.
 *
 * A microtask keeps every actor inside the same tick, which is where the
 * overlap lives.
 */
const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` from `actors` at once, `rounds` times.
 *
 * Every actor's result is captured, including its rejection. A race usually
 * shows up as *two* actors succeeding where one should have, so throwing on the
 * first error would discard the evidence that identifies it.
 */
export async function contend<T>(options: ContentionOptions<T>): Promise<ContentionResult<T>> {
  const random = seededRandom(options.seed);
  const jitterMax = options.jitterMaxMs ?? 0;
  const rounds: RoundOutcome<T>[] = [];

  for (let round = 0; round < options.rounds; round += 1) {
    await options.setup?.(round);

    // Jitter is drawn *before* the actors start, so one round's delays cannot
    // depend on how long the previous round's work took — which would make the
    // sequence depend on machine speed and stop the seed meaning anything.
    const jitter = Array.from({ length: options.actors }, () => random() * jitterMax);

    const outcomes = await Promise.all(
      jitter.map(async (wait, actor): Promise<ActorOutcome<T>> => {
        await delay(wait);
        try {
          return { actor, value: await options.attempt(actor, round), error: null };
        } catch (error) {
          return {
            actor,
            value: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    rounds.push({ round, outcomes });
  }

  return {
    seed: options.seed,
    actors: options.actors,
    rounds,
    replay: `seed=${String(options.seed)} actors=${String(options.actors)} rounds=${String(options.rounds)}`,
  };
}

/**
 * Rounds where the number of winners was not exactly one.
 *
 * The mutual-exclusion shape, which is what most of this codebase's races look
 * like: a claim, a lease, a lock. Both directions are failures and they mean
 * opposite things — two winners is a lost update, zero winners is a livelock
 * where contention starved everybody.
 */
export function violatesMutualExclusion<T>(
  result: ContentionResult<T>,
  isWinner: (outcome: ActorOutcome<T>) => boolean,
): readonly { readonly round: number; readonly winners: number }[] {
  return result.rounds
    .map((round) => ({
      round: round.round,
      winners: round.outcomes.filter(isWinner).length,
    }))
    .filter((entry) => entry.winners !== 1);
}

/** A failure message carrying the seed, so the next person can reproduce it. */
export function describeContention<T>(
  result: ContentionResult<T>,
  violations: readonly { readonly round: number; readonly winners: number }[],
): string {
  if (violations.length === 0)
    return `no violations across ${String(result.rounds.length)} round(s)`;
  return (
    `${String(violations.length)}/${String(result.rounds.length)} round(s) violated mutual exclusion ` +
    `(${violations.map((entry) => `round ${String(entry.round)}: ${String(entry.winners)} winners`).join(', ')}). ` +
    `Replay with ${result.replay}`
  );
}

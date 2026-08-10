import type { Task, WorkItem } from './work-item.js';

/**
 * Task-spec runtime: wave grouping and file-ownership locking.
 *
 * The schema itself lives on the work item (`verify`, `done`, `checkpoint`,
 * `wave`, `file_ownership` — contracts/02 §2.3). What lives here is the logic
 * that consumes it: deciding which tasks may run in parallel without colliding.
 *
 * Pure by design. The evidence engine and the insertion engine both consume
 * this, and putting it in the daemon would make `evidence` depend on `daemon`,
 * inverting the dependency graph.
 */

/** A task is parallel-safe with another only if their declared file ownership is disjoint. */
export interface WaveTask {
  readonly id: string;
  readonly fileOwnership: readonly string[];
  /** Work-item IDs that must complete first. */
  readonly blockedBy: readonly string[];
  /** Author-pinned wave, when the task declares one. */
  readonly wave?: number | null | undefined;
  /**
   * Ordering weight *within* a wave — higher runs first (P1-SCHED-02).
   *
   * Deliberately not a way to jump a wave. Priority answers "which of the things
   * that can run now should run first"; a dependency answers "can this run at
   * all", and letting priority override that would schedule work against code
   * that does not exist yet. So it reorders inside a wave and nothing else.
   */
  readonly priority?: number | undefined;
}

export interface Wave {
  readonly index: number;
  readonly taskIds: readonly string[];
}

/**
 * Risk level as an ordering weight.
 *
 * Not a new field on the card. An author already states `risk_level`, and asking
 * them to *also* state a priority would mean two answers to one question that
 * drift apart — the second one being the stale one.
 */
const PRIORITY_BY_RISK: Readonly<Record<string, number>> = { high: 2, medium: 1, low: 0 };

/** Extracts the wave-relevant fields from a task work item. */
export function toWaveTask(task: Task): WaveTask {
  return {
    id: task.id,
    fileOwnership: task.file_ownership ?? [],
    blockedBy: task.blocked_by ?? [],
    wave: task.wave,
    // Risk becomes priority: high-risk work goes first among the things that can
    // run now, because it is the work most likely to invalidate what follows it.
    priority: PRIORITY_BY_RISK[task.risk_level] ?? 0,
  };
}

/** Whether a task pauses for a human regardless of automated evidence (contract §2.3). */
export function requiresHumanCheckpoint(item: WorkItem): boolean {
  return item.kind === 'task' && item.checkpoint === 'human-verify';
}

function normaliseGlob(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function hasWildcard(pattern: string): boolean {
  return /[*?[{]/.test(pattern);
}

/** Literal prefix of a glob — everything before the first wildcard. */
function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[{]/);
  const head = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
  const lastSlash = head.lastIndexOf('/');
  return lastSlash === -1 ? '' : head.slice(0, lastSlash + 1);
}

/**
 * Whether two ownership patterns could match the same file.
 *
 * **Deliberately conservative.** Deciding glob intersection exactly is
 * expensive and easy to get subtly wrong; this errs toward reporting overlap
 * whenever it cannot prove disjointness. A false positive costs parallelism —
 * two tasks serialize that could have run together. A false negative costs a
 * corrupted merge. Those are not symmetric, so the bias is deliberate.
 */
export function ownershipOverlaps(a: string, b: string): boolean {
  const left = normaliseGlob(a);
  const right = normaliseGlob(b);
  if (left === right) return true;

  const leftGlob = hasWildcard(left);
  const rightGlob = hasWildcard(right);

  // Two literal paths collide only if they are the same path. `src/a.ts` and
  // `src/b.ts` share a directory but never a file.
  if (!leftGlob && !rightGlob) return false;

  // One pattern claims a subtree: the literal collides if it falls inside it.
  if (leftGlob && !rightGlob) return right.startsWith(literalPrefix(left));
  if (rightGlob && !leftGlob) return left.startsWith(literalPrefix(right));

  // Both claim subtrees. Disjoint only if neither root contains the other —
  // anything else cannot be proven disjoint, so it is reported as overlapping.
  const leftPrefix = literalPrefix(left);
  const rightPrefix = literalPrefix(right);
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/** Whether two tasks may run in the same wave. */
export function tasksConflict(a: WaveTask, b: WaveTask): boolean {
  // A task declaring no ownership makes no claim, so it cannot be proven safe
  // against anything — treat it as conflicting with every other task.
  if (a.fileOwnership.length === 0 || b.fileOwnership.length === 0) return true;

  return a.fileOwnership.some((left) =>
    b.fileOwnership.some((right) => ownershipOverlaps(left, right)),
  );
}

export class WaveCycleError extends Error {
  override readonly name = 'WaveCycleError';
  constructor(readonly remaining: readonly string[]) {
    super(
      `dependency cycle among tasks: ${remaining.join(', ')}. ` +
        'No wave can be scheduled until the cycle is broken.',
    );
  }
}

/**
 * Groups tasks into waves: dependency-ordered, with disjoint file ownership
 * inside each wave (ADR-0041).
 *
 * A task pinned to an explicit `wave` is honoured as a *floor*, never a
 * ceiling — an author can say "not before wave 2", but cannot override a
 * dependency or a file-ownership collision, because the author is the one most
 * likely to have missed the conflict.
 */
export function resolveWaves(tasks: readonly WaveTask[]): Wave[] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const scheduled = new Set<string>();
  const waves: Wave[] = [];

  while (remaining.size > 0) {
    const index = waves.length;

    const eligible = [...remaining.values()].filter(
      (task) =>
        task.blockedBy.every((dep) => scheduled.has(dep) || !remaining.has(dep)) &&
        (task.wave === null || task.wave === undefined || task.wave <= index),
    );

    if (eligible.length === 0) {
      // Either a real cycle, or every remaining task is pinned to a later wave.
      const pinnedLater = [...remaining.values()].some(
        (task) => task.wave !== null && task.wave !== undefined && task.wave > index,
      );
      if (pinnedLater) {
        waves.push({ index, taskIds: [] });
        continue;
      }
      throw new WaveCycleError([...remaining.keys()]);
    }

    // Highest priority first, then declaration order. The tiebreak matters:
    // sorting on priority alone would make the grouping depend on the sort's
    // stability, and a wave plan that differs between runs is not a plan.
    const ordered = [...eligible].sort((a, b) => {
      const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
      if (byPriority !== 0) return byPriority;
      return tasks.indexOf(a) - tasks.indexOf(b);
    });

    // Greedy packing, so the grouping is deterministic.
    const chosen: WaveTask[] = [];
    for (const task of ordered) {
      if (chosen.every((other) => !tasksConflict(task, other))) chosen.push(task);
    }

    for (const task of chosen) {
      scheduled.add(task.id);
      remaining.delete(task.id);
    }

    waves.push({ index, taskIds: chosen.map((task) => task.id) });
  }

  return waves;
}

/**
 * Every pair of tasks in one wave that would collide.
 *
 * The assertion `resolveWaves` output must satisfy — exposed so a caller can
 * verify a hand-authored wave assignment rather than trusting it.
 */
export function waveConflicts(
  wave: Wave,
  tasks: readonly WaveTask[],
): { readonly a: string; readonly b: string }[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const conflicts: { a: string; b: string }[] = [];

  for (let i = 0; i < wave.taskIds.length; i += 1) {
    for (let j = i + 1; j < wave.taskIds.length; j += 1) {
      const a = byId.get(wave.taskIds[i] ?? '');
      const b = byId.get(wave.taskIds[j] ?? '');
      if (a && b && tasksConflict(a, b)) conflicts.push({ a: a.id, b: b.id });
    }
  }

  return conflicts;
}

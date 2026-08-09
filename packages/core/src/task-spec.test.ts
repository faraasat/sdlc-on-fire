import { describe, expect, it } from 'vitest';
import {
  ownershipOverlaps,
  requiresHumanCheckpoint,
  resolveWaves,
  tasksConflict,
  waveConflicts,
  WaveCycleError,
  type WaveTask,
} from './task-spec.js';

function task(id: string, fileOwnership: string[], extra: Partial<WaveTask> = {}): WaveTask {
  return { id, fileOwnership, blockedBy: [], ...extra };
}

describe('ownership overlap', () => {
  it('matches identical patterns', () => {
    expect(ownershipOverlaps('src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('separates distinct files', () => {
    expect(ownershipOverlaps('src/a.ts', 'src/b.ts')).toBe(false);
  });

  it('separates distinct subtrees', () => {
    expect(ownershipOverlaps('packages/core/**', 'packages/db/**')).toBe(false);
  });

  it('catches a subtree containing a file', () => {
    expect(ownershipOverlaps('packages/core/**', 'packages/core/src/a.ts')).toBe(true);
  });

  it('treats a root wildcard as claiming everything', () => {
    expect(ownershipOverlaps('**', 'packages/db/x.ts')).toBe(true);
  });

  it('is conservative about two wildcards in one directory', () => {
    // Cannot prove disjoint, so report overlap: a false positive costs
    // parallelism, a false negative costs a corrupted merge.
    expect(ownershipOverlaps('src/*.ts', 'src/*.tsx')).toBe(true);
  });

  it('normalises separators and leading ./', () => {
    expect(ownershipOverlaps('./src/a.ts', 'src\\a.ts')).toBe(true);
  });
});

describe('task conflict', () => {
  it('lets disjoint tasks share a wave', () => {
    expect(tasksConflict(task('a', ['packages/core/**']), task('b', ['packages/db/**']))).toBe(
      false,
    );
  });

  it('conflicts on any overlapping pattern', () => {
    expect(
      tasksConflict(task('a', ['packages/core/**', 'README.md']), task('b', ['README.md'])),
    ).toBe(true);
  });

  it('treats an unclaimed task as conflicting with everything', () => {
    // Declaring nothing is not a claim of safety.
    expect(tasksConflict(task('a', []), task('b', ['packages/db/**']))).toBe(true);
  });
});

describe('wave resolution', () => {
  it('packs disjoint tasks into one wave', () => {
    const tasks = [task('a', ['packages/core/**']), task('b', ['packages/db/**'])];
    const waves = resolveWaves(tasks);

    expect(waves).toHaveLength(1);
    expect([...(waves[0]?.taskIds ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('splits colliding tasks across waves', () => {
    const tasks = [task('a', ['packages/core/**']), task('b', ['packages/core/src/x.ts'])];
    const waves = resolveWaves(tasks);

    expect(waves).toHaveLength(2);
    expect(waves[0]?.taskIds).toEqual(['a']);
    expect(waves[1]?.taskIds).toEqual(['b']);
  });

  it('respects declared dependencies', () => {
    const tasks = [
      task('b', ['packages/db/**'], { blockedBy: ['a'] }),
      task('a', ['packages/core/**']),
    ];
    const waves = resolveWaves(tasks);

    expect(waves[0]?.taskIds).toEqual(['a']);
    expect(waves[1]?.taskIds).toEqual(['b']);
  });

  it('never places conflicting tasks in the same wave', () => {
    const tasks = [
      task('a', ['src/**']),
      task('b', ['src/x.ts']),
      task('c', ['docs/**']),
      task('d', ['src/y.ts']),
    ];
    for (const wave of resolveWaves(tasks)) {
      expect(waveConflicts(wave, tasks)).toEqual([]);
    }
  });

  it('schedules every task exactly once', () => {
    const tasks = [task('a', ['src/**']), task('b', ['src/x.ts']), task('c', ['docs/**'])];
    const scheduled = resolveWaves(tasks).flatMap((wave) => wave.taskIds);

    expect(scheduled.sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(scheduled).size).toBe(3);
  });

  it('honours a pinned wave as a floor, not a ceiling', () => {
    // An author may say "not before wave 2"; they may not override a collision.
    const tasks = [task('a', ['packages/core/**'], { wave: 2 }), task('b', ['packages/db/**'])];
    const waves = resolveWaves(tasks);

    expect(waves[0]?.taskIds).toEqual(['b']);
    expect(waves[2]?.taskIds).toEqual(['a']);
  });

  it('is deterministic across repeated runs', () => {
    const tasks = [task('a', ['src/**']), task('b', ['src/x.ts']), task('c', ['docs/**'])];
    expect(JSON.stringify(resolveWaves(tasks))).toBe(JSON.stringify(resolveWaves(tasks)));
  });

  it('reports a dependency cycle rather than looping forever', () => {
    const tasks = [
      task('a', ['x/**'], { blockedBy: ['b'] }),
      task('b', ['y/**'], { blockedBy: ['a'] }),
    ];
    expect(() => resolveWaves(tasks)).toThrow(WaveCycleError);
  });

  it('handles an empty task set', () => {
    expect(resolveWaves([])).toEqual([]);
  });
});

describe('human checkpoints', () => {
  it('detects a task that pauses for a human', () => {
    const base = {
      $schema: 'https://x/schema.json',
      id: 'TASK-001',
      kind: 'task',
      title: 't',
      status: 'In Progress',
      lifecycle_state: 'implement',
      work_type: 'feature',
      preset: 'standard',
      risk_level: 'low',
      created_at: '2026-08-10T00:00:00.000Z',
      updated_at: '2026-08-10T00:00:00.000Z',
      verify: 'pnpm test',
      done: ['tests pass'],
    } as const;

    expect(requiresHumanCheckpoint({ ...base, checkpoint: 'human-verify' } as never)).toBe(true);
    expect(requiresHumanCheckpoint(base as never)).toBe(false);
  });
});
